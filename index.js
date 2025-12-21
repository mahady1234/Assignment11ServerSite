const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const crypto = require('crypto')


const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(express.json());
app.use(cors({
    origin: ['http://localhost:5173'],
    credentials: true
}));

const admin = require("firebase-admin");
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);


admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


const verifyFBToken = async (req, res, next) => {
    const token = req.headers.authorization;

    if (!token) {
        res.status(401).send({ message: 'Unauthorized access' })
    }


    try {
        const idToken = token.split(' ')[1]
        const decoded = await admin.auth().verifyIdToken(idToken)
        console.log('decoded info', decoded)
        req.decoded_email = decoded.email;
        next()
    }
    catch (error) {
        res.status(401).send({ message: 'Unauthorized access' })
    }
}







const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@myfirstmongodbmodule54.k6sau1y.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        await client.connect();
        console.log("MongoDB Connected Successfully");

        const db = client.db('RedHope');
        const userCollection = db.collection("userCollection");
        const donorRequest = db.collection('donorRequest')
        const donationCollection = db.collection("donations");




        app.get("/users/role",verifyFBToken, async (req, res) => {
            const email = req.query.email;
            if (!email) return res.status(400).send({ error: "Email required" });

            const user = await userCollection.findOne({ email });
            if (!user) return res.status(404).send({ error: "User not found" });

            res.send({ role: user.role }); 
        });





        app.get('/admin/donation-request-stats',verifyFBToken, async (req, res) => {
            try {
                const stats = await donorRequest.aggregate([
                    {
                        $addFields: {
                            createdDate: { $toDate: "$createdAt" }
                        }
                    },
                    {
                        $facet: {

                           
                            daily: [
                                {
                                    $group: {
                                        _id: {
                                            day: { $dayOfMonth: "$createdDate" },
                                            month: { $month: "$createdDate" },
                                            year: { $year: "$createdDate" }
                                        },
                                        count: { $sum: 1 }
                                    }
                                },
                                { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
                                { $limit: 7 }
                            ],

                         
                            weekly: [
                                {
                                    $group: {
                                        _id: {
                                            week: { $week: "$createdDate" },
                                            year: { $year: "$createdDate" }
                                        },
                                        count: { $sum: 1 }
                                    }
                                },
                                { $sort: { "_id.year": 1, "_id.week": 1 } },
                                { $limit: 6 }
                            ],

                          
                            monthly: [
                                {
                                    $group: {
                                        _id: {
                                            month: { $month: "$createdDate" },
                                            year: { $year: "$createdDate" }
                                        },
                                        count: { $sum: 1 }
                                    }
                                },
                                { $sort: { "_id.year": 1, "_id.month": 1 } },
                                { $limit: 12 }
                            ]
                        }
                    }
                ]).toArray();

                res.send(stats[0]);
            } catch (error) {
                res.status(500).send({ message: "Failed to load request stats" });
            }
        });







        app.get('/donations',verifyFBToken, async (req, res) => {
            try {
                const result = await donationCollection.find({}).sort({ paidAt: -1 }).toArray();
                res.send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Failed to fetch donations" });
            }
        });


        
        app.post('/success-payment',verifyFBToken, async (req, res) => {
            const session_id = req.query.session_id;

            try {
               
                const session = await stripe.checkout.sessions.retrieve(session_id);

                
                const existingDonation = await donationCollection.findOne({ transactionId: session.payment_intent });
                if (existingDonation) {
                    return res.status(200).json({ message: 'Donation already recorded', donation: existingDonation });
                }

               
                const newDonation = {
                    donorName: session.customer_details.name,
                    donorEmail: session.customer_details.email,
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    payment_status: session.payment_status,
                    transactionId: session.payment_intent,
                    paidAt: new Date(session.created * 1000),
                };

                const result = await donationCollection.insertOne(newDonation);

                res.status(200).json({ message: 'Donation recorded', donation: newDonation });
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: 'Failed to record donation' });
            }
        });



        app.post('/create-payment-checkout',verifyFBToken, async (req, res) => {
            const information = req.body;
            console.log(information)
            const amount = parseInt(information.formData.donateAmount) * 100;


            const session = await stripe.checkout.sessions.create({

                line_items: [
                    {
                        price_data: {
                            currency: 'usd',
                            unit_amount: amount,
                            product_data: {
                                name: 'Please Donate'
                            }
                        },
                        quantity: 1,
                    },
                ],
                mode: 'payment',
                metadata: {
                    donorName: information?.formData.donorName
                },
                customer_email: information?.formData.userEmail,
                success_url: `${process.env.SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/payment-cancelled`,
            });
            res.send({ url: session.url })
        })




        app.get("/admin/stats",verifyFBToken, async (req, res) => {
            try {
                const totalDonors = await userCollection.countDocuments({
                    role: "donor"
                });

                const totalRequests = await donorRequest.countDocuments();

                const fundingResult = await donationCollection.aggregate([
                    { $match: { payment_status: "paid" } },
                    {
                        $group: {
                            _id: null,
                            total: { $sum: "$amount" }
                        }
                    }
                ]).toArray();

                const totalFunding = fundingResult[0]?.total || 0;

                res.send({
                    totalDonors,
                    totalFunding,
                    totalRequests
                });

            } catch (error) {
                res.status(500).send({ message: "Failed to load admin stats" });
            }
        });



        app.patch("/users/role",verifyFBToken, async (req, res) => {
            const { email, role } = req.query;

            await userCollection.updateOne(
                { email },
                { $set: { role } }
            );

            res.send({ success: true });
        });


        app.patch("/users/status",verifyFBToken, async (req, res) => {
            const { email, status } = req.query;

            await userCollection.updateOne(
                { email },
                { $set: { status } }
            );

            res.send({ success: true });
        });



        app.get("/my-donation-requests",verifyFBToken, async (req, res) => {
            try {
                const { email, status, page = 1, limit = 5 } = req.query;

                if (!email) return res.status(400).send({ message: "Email required" });

                const query = { email };
                if (status && status !== "all") query.status = status;

                const skip = (page - 1) * parseInt(limit);

                const total = await donorRequest.countDocuments(query);
                const requests = await donorRequest
                    .find(query)
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(parseInt(limit))
                    .toArray();

                res.send({
                    total,
                    page: parseInt(page),
                    totalPages: Math.ceil(total / limit),
                    requests,
                });
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Server error" });
            }
        });


        app.get("/admin/blood-donation-requests",verifyFBToken, async (req, res) => {
            const { status = "all", page = 1, limit = 5 } = req.query;

            const query = status === "all" ? {} : { status };
            const skip = (page - 1) * limit;

            const total = await donorRequest.countDocuments(query);
            const requests = await donorRequest
                .find(query)
                .skip(skip)
                .limit(parseInt(limit))
                .sort({ createdAt: -1 })
                .toArray();

            res.send({
                requests,
                totalPages: Math.ceil(total / limit),
            });
        });



        app.get("/public/search-donors",verifyFBToken, async (req, res) => {
            try {
                const { bloodGroup, district, upazila } = req.query;

                const query = { role: "donor", status: "Active" };

                if (bloodGroup) query.bloodGroup = bloodGroup;
                if (district) query.district = district;  
                if (upazila) query.upazila = upazila;   

                const donors = await userCollection
                    .find(query)
                    .project({ name: 1, bloodGroup: 1, district: 1, upazila: 1 }) 
                    .toArray();

                res.send(donors);
            } catch (err) {
                console.error("Search donors error:", err);
                res.status(500).send({ error: "Internal Server Error" });
            }
        });





        app.get("/volunteer/blood-donation-requests",verifyFBToken, async (req, res) => {
            const { status = "all", page = 1, limit = 5 } = req.query;

            const query = status === "all" ? {} : { status };
            const skip = (page - 1) * limit;

            const total = await donorRequest.countDocuments(query);
            const requests = await donorRequest
                .find(query)
                .skip(skip)
                .limit(parseInt(limit))
                .sort({ createdAt: -1 })
                .toArray();

            res.send({
                requests,
                totalPages: Math.ceil(total / limit),
            });
        });


        app.patch("/admin/donation-request/status",verifyFBToken, async (req, res) => {
            const { id, status } = req.body;

            await donorRequest.updateOne(
                { _id: new ObjectId(id) },
                { $set: { status } }
            );

            res.send({ success: true });
        });


        app.patch("/volunteer/donation-request/status",verifyFBToken, async (req, res) => {
            const { id, status } = req.body;

            await donorRequest.updateOne(
                { _id: new ObjectId(id) },
                { $set: { status } }
            );

            res.send({ success: true });
        });



        app.patch('/update/user/status',verifyFBToken, async (req, res) => {
            const { email, status } = req.query;

            if (!email || !status) {
                return res.status(400).send({ message: "Email and status are required" });
            }

            const result = await userCollection.updateOne(
                { email },
                { $set: { status } }
            );

            res.send(result);
        });




       


        app.get("/donorRequest",verifyFBToken, async (req, res) => {
            try {
                const {
                    email,
                    limit = 10,
                    page = 1,
                    status = "pending"
                } = req.query;

                const query = {};

              
                if (email) {
                    query.email = email;
                }

                if (status && status !== "all") {
                    query.status = status;
                }

                const result = await donorRequest
                    .find(query)
                    .sort({ createdAt: -1 })
                    .skip((parseInt(page) - 1) * parseInt(limit))
                    .limit(parseInt(limit))
                    .toArray();

                const total = await donorRequest.countDocuments(query);

                res.send({ data: result, total });
            } catch (error) {
                console.error(error);
                res.status(500).send({ message: "Failed to get donor requests" });
            }
        });










        app.get("/donorRequest/:id",verifyFBToken, async (req, res) => {
            try {
                const { id } = req.params;
                const request = await donorRequest.findOne({ _id: new ObjectId(id) });

                if (!request) return res.status(404).send({ message: "Request not found" });

                res.send(request);
            } catch (error) {
                console.error(error);
                res.status(500).send({ message: "Failed to fetch request" });
            }
        });







        app.patch('/donorRequest/:id',verifyFBToken, async (req, res) => {
            try {
                const { id } = req.params;
                const { status } = req.body;

                if (!status) {
                    return res.status(400).send({ message: "Status is required" });
                }

                const result = await donorRequest.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: {
                            status: status,
                            updatedAt: new Date()
                        }
                    }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).send({ message: "Donation request not found" });
                }

             
                const updatedRequest = await donorRequest.findOne({ _id: new ObjectId(id) });
                res.send(updatedRequest);

            } catch (error) {
                console.error("Update error:", error);
                res.status(500).send({ message: "Internal Server Error" });
            }
        });







        app.delete('/donorRequest/:id',verifyFBToken, async (req, res) => {
            const { id } = req.params;

            const result = await donorRequest.deleteOne({
                _id: new ObjectId(id)
            });

            res.send(result);
        });






        app.post('/donorRequest', verifyFBToken,async (req, res) => {
            const data = req.body;
            data.createdAt = new Date()
            const result = await donorRequest.insertOne(data)
            res.send(result)

        })

        app.post('/users', verifyFBToken, async (req, res) => {
            const user = req.body;

            const isExist = await userCollection.findOne({ email: user.email });
            if (isExist) {
                return res.send({ message: "User already exists" });
            }

            const newUser = {
                name: user.name,
                email: user.email,
                imageUrl: user.imageUrl,
                bloodGroup: user.bloodGroup,
                district: user.district,
                upazila: user.upazila,
                role: 'donor',
                status: 'Active',
                createdAt: new Date()
            };

            const result = await userCollection.insertOne(newUser);
            res.send(result);
        });

        app.get('/users/email/:email',verifyFBToken, async (req, res) => {
            const { email } = req.params;
            const result = await userCollection.findOne({ email });
            res.send(result);
        });

        app.patch('/users/email/:email',verifyFBToken, async (req, res) => {
            const { email } = req.params;
            const updatedInfo = req.body;

            const updateDoc = {
                $set: {
                    name: updatedInfo.name,
                    imageUrl: updatedInfo.imageUrl,
                    district: updatedInfo.district,
                    upazila: updatedInfo.upazila,
                    bloodGroup: updatedInfo.bloodGroup,
                    updatedAt: new Date()
                }
            };

            const result = await userCollection.updateOne({ email }, updateDoc);
            res.send(result);
        });


        app.get('/users/role/:email',verifyFBToken, async (req, res) => {
            const { email } = req.params;
            const result = await userCollection.findOne(
                { email },
                { projection: { role: 1, status: 1 } }
            );
            res.send(result);
        });


        app.get('/users',verifyFBToken, async (req, res) => {
            const users = await userCollection.find().toArray();
            res.send(users);
        });

    } finally {
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('Blood Donation Server is Running');
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});



