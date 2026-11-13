require("dotenv").config();
const express = require("express");
const { GoogleGenAI } = require("@google/genai");
const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.GEMINI_API_KEY) {
    console.error("ERROR: GEMINI_API_KEY is missing from environment variables");
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "1-9y_9hUutt0mQ9CwGyHDDPmBhjNp8Jc6-NU9T9MpElc";

let sheetsApi = null;
let sheetsInitError = null;

try {
    let auth;
    if (process.env.GOOGLE_CREDENTIALS_JSON) {
        const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ["https://www.googleapis.com/auth/spreadsheets"]
        });
    } else if (fs.existsSync(path.join(__dirname, "google-credentials.json"))) {
        auth = new google.auth.GoogleAuth({
            keyFile: path.join(__dirname, "google-credentials.json"),
            scopes: ["https://www.googleapis.com/auth/spreadsheets"]
        });
    } else {
        sheetsInitError = "GOOGLE_CREDENTIALS_JSON environment variable is missing on Render.";
    }

    if (auth) {
        sheetsApi = google.sheets({ version: "v4", auth });
        console.log("Google Sheets API initialized successfully.");
    }
} catch (err) {
    sheetsInitError = "Failed to parse GOOGLE_CREDENTIALS_JSON: " + err.message;
    console.error(sheetsInitError);
}

const DATA_DIR = path.join(__dirname, "participant_data");
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PRIMARY_MODEL = "gemini-3.8-flash";
const FALLBACK_MODEL = "gemini-3.6-flash";
const EMERGENCY_MODEL = "gemini-3.5-flash-lite";

async function ensureSheetHeaders() {
    if (!sheetsApi) throw new Error(sheetsInitError || "Sheets API not initialized.");
    const meta = await sheetsApi.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const existingSheets = meta.data.sheets.map(s => s.properties.title);

    const requests = [];
    if (!existingSheets.includes("Summary")) {
        requests.push({ addSheet: { properties: { title: "Summary" } } });
    }
    if (!existingSheets.includes("Rounds")) {
        requests.push({ addSheet: { properties: { title: "Rounds" } } });
    }
    if (requests.length > 0) {
        await sheetsApi.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            resource: { requests }
        });
    }

    const sumCheck = await sheetsApi.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: "Summary!A1:A1"
    });
    if (!sumCheck.data.values || sumCheck.data.values.length === 0) {
        await sheetsApi.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: "Summary!A1",
            valueInputOption: "USER_ENTERED",
            resource: {
                values: [[
                    "Participant ID", "Date", "Condition Order", "Status", "Rounds Finished",
                    "Baseline Gap (ms)", "Pause Threshold (ms)", "Total Prompts",
                    "Most Useful", "Preferred", "Improved (1-5)", "More Confident (1-5)",
                    "Distracting (1-5)", "Helpful (1-5)", "Final Comment", "Raw_JSON"
                ]]
            }
        });
    }

    const rndCheck = await sheetsApi.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: "Rounds!A1:A1"
    });
    if (!rndCheck.data.values || rndCheck.data.values.length === 0) {
        await sheetsApi.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: "Rounds!A1",
            valueInputOption: "USER_ENTERED",
            resource: {
                values: [[
                    "Participant ID", "Round Pos", "Round Label", "Condition", "Task ID",
                    "Status", "Original Prompt", "Final Prompt", "Prompts Count",
                    "Keystrokes", "Backspaces", "Duration (s)", "Start Support", "End Support",
                    "FB Helpful", "FB Distracting", "FB Confident", "FB Understood", "FB Mental", "FB Frustration"
                ]]
            }
        });
    }
}

// 1. Diagnostic Endpoint: Visit /api/test-sheets in browser to verify & initialize tabs
app.get("/api/test-sheets", async (req, res) => {
    try {
        await ensureSheetHeaders();
        return res.json({
            status: "OK",
            message: "Connected to Google Sheets! Summary and Rounds tabs are ready.",
            spreadsheetId: SPREADSHEET_ID
        });
    } catch (err) {
        return res.status(500).json({
            status: "ERROR",
            exactError: err.message,
            fixHint: err.message.includes("has not been used")
                ? "Enable Google Sheets API in Google Cloud Console."
                : err.message.includes("permission")
                ? "Share the Google Sheet with sheets-logger@gen-lang-client-0281766804.iam.gserviceaccount.com as Editor."
                : "Check GOOGLE_CREDENTIALS_JSON in Render Environment Variables."
        });
    }
});

// 2. Chat API Endpoint
app.post("/api/chat", async (req, res) => {
    req.setTimeout(30000, () => {
        if (!res.headersSent) {
            return res.status(504).json({ error: "Request timed out. Please try sending again." });
        }
    });

    try {
        const { messages } = req.body;
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: "Valid messages are required." });
        }

        const systemMessage = messages.find(m => m.role === "system")?.content || "";
        const userMessage = messages.find(m => m.role === "user")?.content || "";

        let responseText = null;
        let usedModel = PRIMARY_MODEL;
        const modelsToTry = [PRIMARY_MODEL, FALLBACK_MODEL, EMERGENCY_MODEL];

        for (const modelName of modelsToTry) {
            try {
                usedModel = modelName;
                const result = await Promise.race([
                    ai.models.generateContent({
                        model: modelName,
                        contents: userMessage,
                        config: {
                            systemInstruction: systemMessage,
                            responseMimeType: "application/json"
                        }
                    }),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("Timeout after 15s")), 15000)
                    )
                ]);

                responseText = result.text;
                if (responseText) break;
            } catch (err) {
                console.warn(`Model ${modelName} failed/timed out: ${err.message}`);
                if (modelName === modelsToTry[modelsToTry.length - 1]) throw err;
            }
        }

        let cleanedText = responseText.trim()
            .replace(/^```json\s*/i, "")
            .replace(/^```\s*/, "")
            .replace(/\s*```$/, "");

        let parsedJson;
        try {
            parsedJson = JSON.parse(cleanedText);
        } catch (e) {
            parsedJson = { full: cleanedText, simple: [cleanedText] };
        }

        return res.json({
            choices: [{ message: { content: JSON.stringify(parsedJson) } }],
            usedModel: usedModel
        });

    } catch (error) {
        console.error("Gemini API Error:", error.message);
        if (!res.headersSent) {
            return res.status(500).json({ error: error.message || "Gemini processing failed." });
        }
    }
});

// 3. Submit Completed Session & Write to Google Sheets
app.post("/api/submit-session", async (req, res) => {
    try {
        const data = req.body;
        if (!data || !data.pid) {
            return res.status(400).json({ error: "Invalid data format." });
        }

        const filePath = path.join(DATA_DIR, `${data.pid}_${Date.now()}.json`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

        console.log("=== PARTICIPANT SESSION DATA START ===");
        console.log(JSON.stringify(data));
        console.log("=== PARTICIPANT SESSION DATA END ===");

        if (sheetsApi) {
            await ensureSheetHeaders();
            const fin = data.final || {};
            const base = data.baseline || {};
            const totalPrompts = (data.rounds || []).reduce((acc, r) => acc + (r && r.prompts ? r.prompts.length : 0), 0);
            const finishedRounds = (data.rounds || []).filter(r => r && r.status !== "in_progress").length;

            const compactCopy = { ...data, ev: [] };
            const summaryRow = [
                data.pid,
                data.date || new Date().toISOString(),
                data.order || "",
                data.status || "completed",
                finishedRounds,
                base.avgGapMs || "",
                base.pauseThresholdMs || "",
                totalPrompts,
                fin.useful || "",
                fin.pref || "",
                fin.improved || "",
                fin.confident || "",
                fin.distracting || "",
                fin.helpful || "",
                fin.comment || "",
                JSON.stringify(compactCopy).slice(0, 49000)
            ];

            await sheetsApi.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: "Summary!A:P",
                valueInputOption: "USER_ENTERED",
                resource: { values: [summaryRow] }
            });

            const roundRows = (data.plan || []).map((pl, i) => {
                const r = (data.rounds || [])[i] || {};
                const vp = (r.prompts || []).filter(x => !x.failed);
                const firstP = vp[0] ? vp[0].text : "";
                const lastP = vp[vp.length - 1] ? vp[vp.length - 1].text : "";
                const fb = r.fb || {};
                return [
                    data.pid, pl.pos, pl.label, pl.cond, pl.task,
                    r.status || "not_reached", firstP, lastP, vp.length,
                    r.keys || 0, r.bs || 0, r.durMs != null ? (r.durMs / 1000).toFixed(1) : "",
                    r.levelStart ?? "", r.levelEnd ?? "",
                    fb.helpful || "", fb.distracting || "", fb.confident || "",
                    fb.understood || "", fb.mental ?? "", fb.frustration ?? ""
                ];
            });

            if (roundRows.length > 0) {
                await sheetsApi.spreadsheets.values.append({
                    spreadsheetId: SPREADSHEET_ID,
                    range: "Rounds!A:T",
                    valueInputOption: "USER_ENTERED",
                    resource: { values: roundRows }
                });
            }

            console.log(`Saved participant ${data.pid} to Google Sheets.`);
        }

        return res.json({ status: "success", sheetsSaved: !!sheetsApi });
    } catch (err) {
        console.error("Error saving participant session to Sheets:", err.message);
        return res.status(500).json({ error: "Saved locally, but Google Sheets failed: " + err.message });
    }
});

// 4. Safe Live Admin Dashboard API
app.get("/api/admin/all-responses", async (req, res) => {
    try {
        if (sheetsApi) {
            try {
                const response = await sheetsApi.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID,
                    range: "Summary!P2:P"
                });
                const rows = response.data.values || [];
                const sessions = rows.map(row => {
                    try { return row[0] ? JSON.parse(row[0]) : null; } catch (e) { return null; }
                }).filter(Boolean);

                if (sessions.length > 0) {
                    return res.json(sessions);
                }
            } catch (sheetErr) {
                console.warn("Sheets read skipped:", sheetErr.message);
            }
        }

        if (!fs.existsSync(DATA_DIR)) return res.json([]);
        const files = fs.readdirSync(DATA_DIR);
        const allSessions = files
            .filter(f => f.endsWith(".json"))
            .map(file => {
                try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf-8")); } catch (e) { return null; }
            })
            .filter(Boolean);

        return res.json(allSessions);
    } catch (err) {
        console.error("Error loading admin responses:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 5. Fallback Middleware
app.use((req, res, next) => {
    if (req.method === "GET") {
        return res.sendFile(path.join(__dirname, "public", "index.html"));
    }
    next();
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});