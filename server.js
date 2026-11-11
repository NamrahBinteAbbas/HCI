require("dotenv").config();
const express = require("express");
const { GoogleGenAI } = require("@google/genai");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.GEMINI_API_KEY) {
    console.error("ERROR: GEMINI_API_KEY is missing from environment variables");
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Ensure participant data directory exists
const DATA_DIR = path.join(__dirname, "participant_data");
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

app.use(express.json({ limit: "1mb" }));

// 1. Serve static files (HTML, CSS, client JS) from the "public" folder
app.use(express.static(path.join(__dirname, "public")));

const PRIMARY_MODEL = "gemini-3.8-flash";
const FALLBACK_MODEL = "gemini-3.6-flash";
const EMERGENCY_MODEL = "gemini-3.5-flash-lite";

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

// 3. Submit Completed Session Endpoint
app.post("/api/submit-session", (req, res) => {
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

        return res.json({ status: "success" });
    } catch (err) {
        console.error("Error saving participant session:", err);
        return res.status(500).json({ error: "Failed to save data." });
    }
});

// 4. Live Admin Dashboard API (Serves all participant responses)
app.get("/api/admin/all-responses", (req, res) => {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            return res.json([]);
        }
        const files = fs.readdirSync(DATA_DIR);
        const allSessions = files
            .filter(f => f.endsWith(".json"))
            .map(file => {
                try {
                    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf-8"));
                } catch (e) {
                    return null;
                }
            })
            .filter(Boolean);

        return res.json(allSessions);
    } catch (err) {
        console.error("Error loading admin responses:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 5. Fallback Middleware: Express v5 compatible static HTML route
app.use((req, res, next) => {
    if (req.method === "GET") {
        return res.sendFile(path.join(__dirname, "public", "index.html"));
    }
    next();
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});