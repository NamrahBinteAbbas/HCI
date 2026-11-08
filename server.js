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

        console.log(`Saved results for participant: ${data.pid}`);
        return res.json({ status: "success" });
    } catch (err) {
        console.error("Error saving participant session:", err);
        return res.status(500).json({ error: "Failed to save data." });
    }
});

// 4. Researcher Secret Data Download Endpoint
app.get("/api/researcher/download-all-data", (req, res) => {
    const authKey = req.query.key;
    // Replace with your secret passphrase
    if (authKey !== "my_secret_admin_pass_123") {
        return res.status(401).json({ error: "Unauthorized access." });
    }

    try {
        const files = fs.readdirSync(DATA_DIR);
        const allSessions = files.map(file => {
            const content = fs.readFileSync(path.join(DATA_DIR, file), "utf-8");
            return JSON.parse(content);
        });

        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", "attachment; filename=all_participants.json");
        return res.send(JSON.stringify(allSessions, null, 2));
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 5. Fallback Route: Serve index.html for any root requests
app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});