import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import admin from "firebase-admin";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

/* --------------------------------------------------
   FIREBASE ADMIN INITIALIZATION
---------------------------------------------------*/

const serviceAccount = {
  project_id: process.env.FIREBASE_PROJECT_ID,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
};

// Validate Firebase credentials
if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
  console.error("❌ Missing Firebase environment variables");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const firestore = admin.firestore();
console.log("🔥 Firebase Admin initialized");

/* --------------------------------------------------
   DEEPSEEK SETUP
---------------------------------------------------*/

const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

/* --------------------------------------------------
   FIRESTORE READ FUNCTIONS
---------------------------------------------------*/

async function getUserData(userId) {
  if (!userId) return null;

  try {
    const snap = await firestore.collection("users").doc(userId).get();
    return snap.exists ? snap.data() : null;
  } catch (error) {
    console.error("❌ Error fetching user data:", error);
    return null;
  }
}

async function getTimetable(userId) {
  try {
    const doc = await firestore.collection("users").doc(userId).get();
    return doc.exists ? doc.data().timetable || {} : {};
  } catch (error) {
    console.error("❌ Timetable error:", error);
    return {};
  }
}

async function getExams(userId) {
  try {
    const doc = await firestore.collection("users").doc(userId).get();
    return doc.exists ? doc.data().exams || [] : [];
  } catch (error) {
    console.error("❌ Exams error:", error);
    return [];
  }
}

async function getGPA(userId) {
  try {
    const doc = await firestore.collection("users").doc(userId).get();
    return doc.exists ? doc.data().gpa_data || {} : {};
  } catch (error) {
    console.error("❌ GPA error:", error);
    return {};
  }
}

async function getCourseUnits(userId) {
  try {
    const doc = await firestore.collection("users").doc(userId).get();
    return doc.exists ? doc.data().units || {} : {};
  } catch (error) {
    console.error("❌ Units error:", error);
    return {};
  }
}

async function getChatHistory(userId) {
  try {
    const chatRef = firestore
      .collection("users")
      .doc(userId)
      .collection("chat_history");

    const snap = await chatRef.orderBy("timestamp", "desc").limit(5).get();

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

/* --------------------------------------------------
   FIREBASE AUTHENTICATION MIDDLEWARE
---------------------------------------------------*/

const authenticateFirebase = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized. No token provided.' });
  }
  
  const token = authHeader.split('Bearer ')[1];
  
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.userId = decodedToken.uid;
    console.log(`✅ Authenticated user: ${req.userId}`);
    next();
  } catch (error) {
    console.error('❌ Firebase auth error:', error);
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
};

/* --------------------------------------------------
   /ask — AI ENDPOINT (WITH AUTHENTICATION)
---------------------------------------------------*/

app.post("/ask", authenticateFirebase, async (req, res) => {
  try {
    const { query, timetable } = req.body;
    const userId = req.userId;
    
    if (!query) return res.status(400).json({ error: "query is required" });

    // Fetch all user data
    const profile = await getUserData(userId);
    const userTimetable = timetable || (await getTimetable(userId));
    const exams = await getExams(userId);
    const gpa = await getGPA(userId);
    const courseUnits = await getCourseUnits(userId);
    const lastChats = await getChatHistory(userId);

    const formattedProfile = profile
      ? {
          nickname: profile.nickname,
          course: profile.course,
          current_semester: profile.current_semester,
          total_semesters: profile.total_semesters,
        }
      : {};

    // System prompt
    const systemPrompt = `
You are REMI — an intelligent student assistant.
Use only the following data to answer the user's question.
Never make up information.

PROFILE:
${JSON.stringify(formattedProfile, null, 2)}

TIMETABLE:
${JSON.stringify(userTimetable, null, 2)}

EXAMS:
${JSON.stringify(exams, null, 2)}

GPA:
${JSON.stringify(gpa, null, 2)}

COURSE UNITS:
${JSON.stringify(courseUnits, null, 2)}

RECENT CHATS:
${JSON.stringify(lastChats, null, 2)}

RULES:
1. If data is missing, politely say you don't have that information.
2. Never invent information.
3. Keep answers short (1–3 paragraphs).
4. Friendly and helpful tone.
`;

    // Send request to DeepSeek
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
    res.status(500).json({
      error: "AI processing failed",
      details: err.message,
    });
  }
});

/* --------------------------------------------------
   HEALTH CHECK
---------------------------------------------------*/

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

/* --------------------------------------------------
   START SERVER
---------------------------------------------------*/

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 REMI backend running on port ${PORT}`)
);