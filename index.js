require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require("firebase-admin");
const { messaging } = require('firebase-admin');
// const fs = require('fs');


const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: ['http://localhost:5173'], // Vite default
    credentials: true,
}));
app.use(express.json());

const serviceAccount = require("./assignment11firebasesdk.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

// MongoDB setup
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
let usersCollection, foodCollection, foodRequestCollection, paymentCollection;

// Connect to MongoDB
async function run() {
    try {
        await client.connect();
        await client.db("admin").command({ ping: 1 });
        console.log("Connected to MongoDB");

        const db = client.db('foodshare');
        usersCollection = db.collection('users');
        foodCollection = db.collection("food");
        foodRequestCollection = db.collection("requestedfoods");
        paymentCollection = db.collection("payments");


        const verifyFBToken = async (req, res, next) => {
            const authHeader = req.headers.authorization;
            if (!authHeader) {
                return res.status(401).send({ message: 'Unauthorized Access' });
            }
            const token = authHeader.split(' ')[1];
            if (!token) {
                return res.status(401).send({ message: 'Unauthorized Access' });
            }

            //verify the token
            try {
                const decoded = await admin.auth().verifyIdToken(token);
                req.decoded = decoded;
                next();
            }
            catch (error) {
                return res.status(403).send({ message: 'Forbidden Access' });
            }

        };

        // Create or update user
        app.post("/users", async (req, res) => {
            try {
                const { email, name, photourl, membership = "no" } = req.body;
                if (!email) return res.status(400).json({ error: "Email is required" });

                const result = await usersCollection.updateOne(
                    { email },
                    { $setOnInsert: { email, membership }, $set: { name, photourl } },
                    { upsert: true }
                );
                res.json({ result });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        // Get all users
        app.get("/users", async (req, res) => {
            try {
                const users = await usersCollection.find().toArray();
                res.json(users);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        // Get user by email
        app.get("/users/:email", async (req, res) => {
            try {
                const email = req.params.email;
                const user = await usersCollection.findOne({ email });
                if (!user) return res.status(404).json({ error: "User not found" });
                res.json(user);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        // Update membership
        app.patch("/users/membership/:email", async (req, res) => {
            try {
                const email = req.params.email;
                const result = await usersCollection.updateOne({ email }, { $set: { membership: "yes" } });
                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        // --- Food ---
        app.post("/food", async (req, res) => {
            try {
                const { donorEmail, foodName } = req.body;
                if (!donorEmail || !foodName) return res.status(400).json({ error: "donorEmail and foodName required" });

                const data = { ...req.body, createdAt: new Date() };
                const result = await foodCollection.insertOne(data);
                res.status(201).json({ insertedId: result.insertedId });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        app.get("/food", async (req, res) => {
            try {
                const search = req.query.search || "";
                const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;

                const filter = {
                    foodStatus: "available",
                    expiredDateTime: { $gt: new Date() },
                    foodName: { $regex: search, $options: "i" },
                };

                const foods = await foodCollection.find(filter).sort({ expiredDateTime: sortOrder }).toArray();
                res.json(foods);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        app.get("/food/:id", async (req, res) => {
            try {
                const food = await foodCollection.findOne({ _id: new ObjectId(req.params.id) });
                if (!food) return res.status(404).json({ error: "Food not found" });
                res.json(food);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        app.put("/food/:id", async (req, res) => {
            try {
                const result = await foodCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: req.body });
                if (result.matchedCount === 0) return res.status(404).json({ error: "Food not found" });
                res.json({ message: "Food updated", result });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        app.patch("/food/:id", async (req, res) => {
            try {
                const { foodStatus } = req.body;
                const result = await foodCollection.updateOne(
                    { _id: new ObjectId(req.params.id) },
                    { $set: { foodStatus: foodStatus || "requested" } }
                );
                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        // --- Food Requests ---
        app.post("/requestedfoods", async (req, res) => {
            try {
                const data = { ...req.body, requestedAt: new Date() };
                const result = await foodRequestCollection.insertOne(data);
                res.status(201).json({ insertedId: result.insertedId });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });


        app.get("/myfoodrequest", verifyFBToken, async (req, res) => {
            try {
                const userEmail = req.query.email;
                if (userEmail !== req.decoded.email) return res.status(403).json({ error: "Forbidden" });
                const requests = await foodRequestCollection.find({ userEmail }).toArray();
                res.json(requests);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        // --- Payments ---
        app.post("/create-payment-intent", async (req, res) => {
            try {
                const { price } = req.body;
                if (!price || price <= 0) return res.status(400).json({ error: "Invalid price" });

                const paymentIntent = await stripe.paymentIntents.create({
                    amount: Math.round(price * 100),
                    currency: "usd",
                    automatic_payment_methods: { enabled: true },
                });

                res.json({ clientSecret: paymentIntent.client_secret });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        app.post("/payments", async (req, res) => {
            try {
                const { email, amount, transactionId, status, date } = req.body;
                if (!email || !amount || !transactionId || !status) return res.status(400).json({ error: "Missing payment data" });

                const data = { email, amount, transactionId, status, date: date || new Date() };
                const result = await paymentCollection.insertOne(data);
                res.status(201).json({ insertedId: result.insertedId });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

    } catch (error) {
        console.error("MongoDB connection failed:", error);
        process.exit(1); // Exit if Mongo fails
    }
}
run();


// Default route
app.get('/', (req, res) => {
    res.send('Food Zone Server Running properly');
});

// Start server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
