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

const MODELS_TO_TRY = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];

async function generateSafe(modelName, systemMessage, userMessage) {
    // Try official @google/genai SDK first
    try {
        const result = await ai.models.generateContent({
            model: modelName,
            contents: userMessage,
            config: systemMessage ? { systemInstruction: systemMessage } : undefined
        });
        if (result && result.text) return result.text;
    } catch (sdkErr) {
        console.warn(`SDK call failed for ${modelName}, trying direct REST:`, sdkErr.message);
    }

    // Direct REST fallback (works regardless of @google/genai version on Render)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
    const payload = {
        contents: [{ role: "user", parts: [{ text: userMessage }] }]
    };
    if (systemMessage) {
        payload.systemInstruction = { parts: [{ text: systemMessage }] };
    }

    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        throw new Error(json?.error?.message || `Gemini HTTP ${resp.status}`);
    }

    const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    if (!text) throw new Error("Empty text from Gemini REST API");
    return text;
}

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

// Diagnostic 1: Test Gemini directly in browser (/api/test-gemini)
app.get("/api/test-gemini", async (req, res) => {
    const errors = {};
    for (const modelName of MODELS_TO_TRY) {
        try {
            const reply = await generateSafe(
                modelName,
                'Return only valid JSON: {"full":"Hello","simple":["Hi"]}',
                "Say hello"
            );
            return res.json({ status: "OK", workingModel: modelName, rawReply: reply });
        } catch (err) {
            errors[modelName] = err.message;
        }
    }
    return res.status(500).json({ status: "ERROR", errors });
});

// Diagnostic 2: Test Google Sheets directly in browser (/api/test-sheets)
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
            exactError: err.message
        });
    }
});

// Chat API Endpoint
app.post("/api/chat", async (req, res) => {
    try {
        const { messages } = req.body;
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: "Valid messages are required." });
        }

        const systemMessage = messages.find(m => m.role === "system")?.content || "";
        const userMessage = messages.find(m => m.role === "user")?.content || "";

        let responseText = null;
        let usedModel = MODELS_TO_TRY[0];
        let lastError = null;

        for (const modelName of MODELS_TO_TRY) {
            try {
                usedModel = modelName;
                responseText = await generateSafe(modelName, systemMessage, userMessage);
                if (responseText) break;
            } catch (err) {
                lastError = err;
                console.error(`Model ${modelName} error:`, err.message);
            }
        }

        if (!responseText) {
            return res.status(500).json({ error: lastError ? lastError.message : "All Gemini models failed." });
        }

        // Extract JSON object even if Gemini wraps it in markdown or extra text
        let cleanedText = responseText.trim()
            .replace(/^```json\s*/i, "")
            .replace(/^```\s*/, "")
            .replace(/\s*```$/, "");

        const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
        if (jsonMatch) cleanedText = jsonMatch[0];

        let parsedJson;
        try {
            parsedJson = JSON.parse(cleanedText);
            if (!parsedJson.full) parsedJson.full = cleanedText;
            if (!Array.isArray(parsedJson.simple)) {
                parsedJson.simple = parsedJson.full.split(/\.\s+/).filter(Boolean).slice(0, 4);
            }
        } catch (e) {
            parsedJson = {
                full: cleanedText,
                simple: cleanedText.split(/\.\s+/).filter(Boolean).slice(0, 4)
            };
        }

        return res.json({
            choices: [{ message: { content: JSON.stringify(parsedJson) } }],
            usedModel
        });

    } catch (error) {
        console.error("Gemini API Fatal Error:", error.message);
        return res.status(500).json({ error: error.message || "Gemini processing failed." });
    }
});

// Submit Completed Session & Write to Google Sheets
app.post("/api/submit-session", async (req, res) => {
    try {
        const data = req.body;
        if (!data || !data.pid) {
            return res.status(400).json({ error: "Invalid data format." });
        }

        const filePath = path.join(DATA_DIR, `${data.pid}_${Date.now()}.json`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

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
        }

        return res.json({ status: "success", sheetsSaved: !!sheetsApi });
    } catch (err) {
        console.error("Error saving participant session to Sheets:", err.message);
        return res.status(500).json({ error: "Saved locally, but Google Sheets failed: " + err.message });
    }
});

// Safe Live Admin Dashboard API
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

// Fallback Middleware
app.use((req, res, next) => {
    if (req.method === "GET") {
        return res.sendFile(path.join(__dirname, "public", "index.html"));
    }
    next();
});

const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;