import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import admin from "firebase-admin";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

/* ==================================================
   🔥 FIREBASE ADMIN INITIALIZATION
====================================================*/
const serviceAccount = {
  project_id: process.env.FIREBASE_PROJECT_ID,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
};

if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
  console.error("❌ Missing Firebase environment variables");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const firestore = admin.firestore();
console.log("🔥 Firebase Admin initialized");

/* ==================================================
   🤖 DEEPSEEK SETUP
====================================================*/
const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

/* ==================================================
   🔎 FIRESTORE QUERIES
====================================================*/
async function getUserData(userId) {
  try {
    const snap = await firestore.collection("users").doc(userId).get();
    return snap.exists ? snap.data() : null;
  } catch (error) {
    console.error("❌ User data error:", error);
    return null;
  }
}

async function getTimetable(userId) {
  try {
    const snap = await firestore.collection("users").doc(userId).get();
    return snap.exists ? snap.data().timetable || {} : {};
  } catch (error) {
    console.error("❌ Timetable error:", error);
    return {};
  }
}

async function getExams(userId) {
  try {
    const snap = await firestore.collection("users").doc(userId).get();
    return snap.exists ? snap.data().exams || [] : [];
  } catch (error) {
    console.error("❌ Exams error:", error);
    return [];
  }
}

async function getGPA(userId) {
  try {
    const snap = await firestore.collection("users").doc(userId).get();
    return snap.exists ? snap.data().gpa_data || {} : {};
  } catch (error) {
    console.error("❌ GPA error:", error);
    return {};
  }
}

async function getCourseUnits(userId) {
  try {
    const snap = await firestore.collection("users").doc(userId).get();
    return snap.exists ? snap.data().units || {} : {};
  } catch (error) {
    console.error("❌ Units error:", error);
    return {};
  }
}

async function getChatHistory(userId) {
  try {
    const ref = firestore.collection("users").doc(userId).collection("chat_history");
    const snap = await ref.orderBy("timestamp", "desc").limit(5).get();
    return snap.docs.map((d) => ({
      message: d.data().message,
      isUser: d.data().isUser,
      timestamp: d.data().timestamp?.toDate?.() || new Date(),
    }));
  } catch (error) {
    console.error("❌ Chat history error:", error);
    return [];
  }
}

/* ==================================================
   🔐 FIREBASE AUTH MIDDLEWARE
====================================================*/
const authenticateFirebase = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized. No token provided." });
  }

  const token = authHeader.split("Bearer ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.userId = decoded.uid;
    console.log(`✅ Authenticated user: ${req.userId}`);
    next();
  } catch (error) {
    console.error("❌ Firebase auth error:", error);
    return res.status(401).json({ error: "Invalid or expired token." });
  }
};

/* ==================================================
   💬 /ask — AI ENDPOINT
====================================================*/
app.post("/ask", authenticateFirebase, async (req, res) => {
  try {
    const { query, timetable } = req.body;
    const userId = req.userId;

    if (!query) return res.status(400).json({ error: "Query is required" });

    /* ---- Fetch user data ---- */
    const profile = await getUserData(userId);
    const userTimetable = timetable || (await getTimetable(userId));
    const exams = await getExams(userId);
    const gpa = await getGPA(userId);
    const courseUnits = await getCourseUnits(userId);
    const lastChats = await getChatHistory(userId);

    /* ---- Prepare profile ---- */
    const formattedProfile = profile
      ? {
          nickname: profile.nickname,
          course: profile.course,
          current_semester: profile.current_semester,
          total_semesters: profile.total_semesters,
        }
      : {};

    /* ---- DATE & TIME (Uganda Timezone) ---- */
    const now = new Date();
    const UGTime = now.toLocaleString("en-UG", { timeZone: "Africa/Kampala" });

    /* ---- System prompt ---- */
    const systemPrompt = `
You are REMI — a friendly academic assistant.

You may use the user’s academic data **only if their question is academic**.

For general questions (life, science, date, time, advice, etc.) answer normally.

📌 **Current Date & Time Info (Uganda):**
- Full Date & Time: ${UGTime}
- ISO: ${now.toISOString()}

📌 USER DATA (only use if relevant):
PROFILE: ${JSON.stringify(formattedProfile, null, 2)}
TIMETABLE: ${JSON.stringify(userTimetable, null, 2)}
EXAMS: ${JSON.stringify(exams, null, 2)}
GPA: ${JSON.stringify(gpa, null, 2)}
COURSE UNITS: ${JSON.stringify(courseUnits, null, 2)}
RECENT CHATS: ${JSON.stringify(lastChats, null, 2)}

RULES:
1. If data is missing, say it's unavailable.
2. Do NOT invent academic information.
3. Keep answers short (1–3 paragraphs).
4. Friendly & helpful tone.
`;

    /* ---- AI request ---- */
    const completion = await deepseek.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query },
      ],
      temperature: 0.3,
      max_tokens: 500,
    });

    const answer = completion.choices[0].message.content;

    res.json({
      answer,
      profile: formattedProfile,
      timetable: userTimetable,
      exams,
      gpa,
      courseUnits,
    });
  } catch (err) {
    console.error("❌ AI Error:", err);
    res.status(500).json({ error: "AI processing failed", details: err.message });
  }
});

/* ==================================================
   ❤️ HEALTH CHECK
====================================================*/
app.get("/health", async (req, res) => {
  try {
    await firestore.collection("users").limit(1).get();
    res.json({
      status: "healthy",
      firebase: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: "unhealthy",
      firebase: "disconnected",
      error: error.message,
    });
  }
});

/* ==================================================
   🚀 START SERVER
====================================================*/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 REMI backend running on port ${PORT}`)
);
