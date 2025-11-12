require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require("firebase-admin");
const { messaging } = require('firebase-admin');
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);



const app = express();
const port = process.env.PORT || 3000;

// Middleware
const corsOptions = {
    origin: [
        "http://localhost:5173",
        "https://assignment11-b015f.web.app"
    ],
    credentials: true, // allow cookies and auth headers
};

app.use(cors(corsOptions));

app.use(express.json());

const serviceAccount = require("./assignment11firebasesdk.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

// MongoDB setup
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
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
        // --- Users ---
        app.post("/users", async (req, res) => {
            const usersCollection = db.collection("users");
            const { email, name, photourl, membership = "no", post = 0 } = req.body;

            const result = await usersCollection.updateOne(
                { email },
                {
                    $setOnInsert: { email, membership, post, createdAt: new Date() }, // add post here
                    $set: { name, photourl, updatedAt: new Date() }
                },
                { upsert: true }
            );

            res.json({ success: true, upserted: result.upsertedCount > 0 });
        });


        app.get("/users", async (req, res) => {

            const users = await db.collection("users").find().toArray();
            res.json(users);
        });

        app.get("/users/:email", async (req, res) => {

            const usersCollection = db.collection("users");
            const user = await usersCollection.findOne({ email: req.params.email });
            user ? res.json(user) : res.status(404).json({ error: "User not found" });
        });

        // app.patch("/users/membership/:email", async (req, res) => {

        //     const usersCollection = db.collection("users");
        //     const result = await usersCollection.updateOne(
        //         { email: req.params.email },
        //         { $set: { membership: "yes", membershipUpdatedAt: new Date() } }
        //     );
        //     result.matchedCount === 0 ? res.status(404).json({ error: "User not found" }) : res.json({ success: true });
        // });

        // --- Food ---
        app.post("/food", async (req, res) => {
            try {
                const foodCollection = db.collection("food");
                const usersCollection = db.collection("users");

                // Insert the food object as sent from frontend
                const result = await foodCollection.insertOne({
                    ...req.body,
                    createdAt: new Date(), // just metadata, no redundancy
                });

                // Increment the user's post count
                if (req.body.donorEmail) {
                    await usersCollection.updateOne(
                        { email: req.body.donorEmail },
                        { $inc: { post: 1 } }
                    );
                }

                res.status(201).json({
                    success: true,
                    insertedId: result.insertedId
                });

            } catch (error) {
                console.error("Error inserting food:", error);
                res.status(500).json({ success: false, message: "Failed to add food" });
            }
        });


        app.get("/food", async (req, res) => {

            const foods = await db.collection("food").find().toArray();

            res.json(foods);
        });

        app.get("/food/:id", async (req, res) => {

            const foodCollection = db.collection("food");

            if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid ID" });
            const food = await foodCollection.findOne({ _id: new ObjectId(req.params.id) });
            food ? res.json(food) : res.status(404).json({ error: "Food not found" });
        });

        app.put("/food/:id", async (req, res) => {

            const foodCollection = db.collection("food");
            const { _id, ...updateData } = req.body;
            updateData.updatedAt = new Date();
            const result = await foodCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: updateData });
            res.json({ success: true, result });
        });

        // DELETE a specific food by ID
        app.delete("/food/:id", verifyFBToken, async (req, res) => {
            try {
                const { id } = req.params;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({ error: "Invalid food ID" });
                }

                // Optionally, check if the food belongs to the logged-in user
                const food = await foodCollection.findOne({ _id: new ObjectId(id) });
                if (!food) {
                    return res.status(404).json({ error: "Food not found" });
                }

                // If you want to allow only the donor to delete their food
                if (food.donorEmail !== req.decoded.email) {
                    return res.status(403).json({ error: "You are not allowed to delete this food" });
                }

                const result = await foodCollection.deleteOne({ _id: new ObjectId(id) });

                if (result.deletedCount === 0) {
                    return res.status(500).json({ error: "Failed to delete food" });
                }

                res.json({ success: true, message: "Food deleted successfully" });
            } catch (error) {
                console.error("Error deleting food:", error);
                res.status(500).json({ error: "Server Error" });
            }
        });


        app.get("/available-foods", async (req, res) => {
            try {
                const { search } = req.query; // optional search query
                const foodCollection = db.collection("food");

                // Build the query
                const query = { foodStatus: "available" };

                // Add search filter if provided
                if (search) {
                    query.foodName = { $regex: search, $options: "i" }; // case-insensitive search
                }

                // Fetch foods from DB
                const foods = await foodCollection.find(query).toArray();

                res.json(foods);
            } catch (err) {
                console.error("Error fetching available foods:", err);
                res.status(500).json({ message: "Server Error" });
            }
        });

        // GET foods donated by a specific logged-in user
        app.get("/food/user/:email", verifyFBToken, async (req, res) => {
            try {
                const email = req.params.email;

                if (!email) {
                    return res.status(400).json({ message: "Email is required" });
                }

                const foods = await foodCollection
                    .find({ donorEmail: email })
                    .sort({ createdAt: -1 })
                    .toArray();

                res.json(foods);
            } catch (error) {
                console.error("Error fetching user's foods:", error);
                res.status(500).json({ message: "Server Error" });
            }
        });

        // --- Food Requests ---
        // POST /api/request-food
        app.post("/requestfoods", async (req, res) => {
            try {
                const { foodId, userEmail, requestedQuantity, additionalNotes } = req.body;

                const foodRequestCollection = db.collection("requestedfoods");

                // Check if a request already exists for the same user and food
                const existingRequest = await foodRequestCollection.findOne({
                    foodId,
                    userEmail
                });

                if (existingRequest) {
                    // Update the requestedQuantity and optionally update notes
                    const updatedQuantity = existingRequest.requestedQuantity + requestedQuantity;
                    await foodRequestCollection.updateOne(
                        { _id: existingRequest._id },
                        { $set: { requestedQuantity: updatedQuantity, additionalNotes } }
                    );

                    return res.json({
                        success: true,
                        message: "Request updated successfully",
                        updatedQuantity
                    });
                }

                // Otherwise, create a new request
                const result = await foodRequestCollection.insertOne({
                    foodId,
                    userEmail,
                    requestedQuantity,
                    additionalNotes,
                    status: "pending",
                    requestedAt: new Date(),
                });

                res.json({
                    success: true,
                    message: "Request submitted successfully",
                    insertedId: result.insertedId
                });
            } catch (error) {
                console.error("Request error:", error);
                res.status(500).json({
                    success: false,
                    message: "Something went wrong. Please try again later."
                });
            }
        });



        app.get("/myfoodrequest", verifyFBToken, async (req, res) => {

            const foodRequestCollection = db.collection("requestedfoods");
            const requests = await foodRequestCollection.find({ userEmail: req.decoded.email }).sort({ requestedAt: -1 }).toArray();
            res.json(requests);
        });

        app.delete("/myfoodrequest/:id", async (req, res) => {
            const requestId = req.params.id;

            try {
                // 1. Find the requested food
                const requestedFood = await foodRequestCollection.findOne({ _id: new ObjectId(requestId) });
                if (!requestedFood) return res.status(404).json({ message: "Requested food not found" });

                const { foodId, userEmail } = requestedFood;

                // 2. Delete from requestedfoods
                await foodRequestCollection.deleteOne({ _id: new ObjectId(requestId) });

                // 3. Increment food quantity in foods collection
                await foodCollection.updateOne(
                    { _id: new ObjectId(foodId) },
                    { $inc: { foodQuantity: 1 } }
                );

                // 4. Decrement user's foodRequest count
                await usersCollection.updateOne(
                    { email: userEmail },
                    { $inc: { foodRequest: -1 } }
                );

                res.status(200).json({ message: "Food request canceled successfully" });
            } catch (err) {
                console.error("Error in DELETE /myfoodrequest/:id:", err);
                res.status(500).json({ message: "Server error" });
            }
        });


        // --- Payments ---
        // app.post("/create-payment-intent", async (req, res) => {
        //     const { price } = req.body;
        //     const paymentIntent = await stripe.paymentIntents.create({ amount: Math.round(price * 100), currency: "usd", automatic_payment_methods: { enabled: true } });
        //     res.json({ clientSecret: paymentIntent.client_secret });
        // });

        app.post("/create-payment-intent", async (req, res) => {
            try {
                const { price } = req.body;
                if (!price) return res.status(400).json({ error: "Price is required" });

                const amount = Math.round(price * 100);

                const paymentIntent = await stripe.paymentIntents.create({
                    amount,
                    currency: "usd",
                    automatic_payment_methods: { enabled: true },
                });

                res.json({ clientSecret: paymentIntent.client_secret });
            } catch (error) {
                console.error("❌ Stripe payment intent error:", error.message);
                res.status(500).json({ error: error.message });
            }
        });

        // app.post("/payments", async (req, res) => {

        //     const paymentCollection = db.collection("payments");
        //     const result = await paymentCollection.insertOne({ ...req.body, createdAt: new Date() });
        //     res.json({ success: true, insertedId: result.insertedId });
        // });

        app.post("/payments", async (req, res) => {
            try {
                const paymentCollection = db.collection("payments");
                const { email, amount, transactionId, status } = req.body;

                if (!email || !amount || !transactionId || !status) {
                    return res.status(400).json({ error: "Missing payment details" });
                }

                const paymentDoc = {
                    email,
                    amount,
                    transactionId,
                    status,
                    date: new Date(),
                };

                const result = await paymentCollection.insertOne(paymentDoc);
                res.json({ success: true, insertedId: result.insertedId });
            } catch (error) {
                console.error("❌ Payment save error:", error.message);
                res.status(500).json({ error: error.message });
            }
        });


        app.patch("/users/membership/:email", async (req, res) => {
            try {
                const usersCollection = db.collection("users");
                const result = await usersCollection.updateOne(
                    { email: req.params.email },
                    {
                        $set: {
                            membership: "yes",
                            membershipUpdatedAt: new Date(),
                        },
                    }
                );

                if (result.matchedCount === 0)
                    return res.status(404).json({ error: "User not found" });

                res.json({ success: true });
            } catch (error) {
                console.error("❌ Membership update error:", error.message);
                res.status(500).json({ error: error.message });
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
