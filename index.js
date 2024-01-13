const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 5000;
const jwt = require("jsonwebtoken");
const app = express();
require("dotenv").config();
app.use(cors());
app.use(express.json());
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.4k6eqxi.mongodb.net/?retryWrites=true&w=majority`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

function verifyJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send("Unauthorized Access");
  }
  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.ACCESS_TOKEN, function (error, decoded) {
    if (error) {
      return res.status(403).send({ message: "Forbidden Access" });
    }
    req.decoded = decoded;
    next();
  });
}


async function run() {
  try {
   await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");


    const appointmentOptionCollection = client
      .db("doctorPortal")
      .collection("appointmentOptions");
    const bookingCollection = client.db("doctorPortal").collection("bookings");
    const usersCollection = client.db("doctorPortal").collection("users");
    const doctorsCollection = client.db("doctorPortal").collection("Doctors");
    const paymentsCollection = client.db("doctorPortal").collection('Payments');

    //make Sure to run verifyAdmin After verifyJWT middleware
    const veriFyAdmin = async (req, res, next) =>{
      const decodedEmail = req.decoded.email;
      const query = { email: decodedEmail };
      const user = await usersCollection.findOne(query);
      if (user?.role !== "admin") {
        return res.status(403).send({ message: "Forbidden Access" });
      }

      next();
    }

    app.get('/allappointment', async(req, res)=>{
      const result = await appointmentOptionCollection.find().toArray();
      res.send(result)
      
    })

    app.get("/appointmentOptions", async (req, res) => {
      const date = req.query.date;
      const query = {};
      const options = await appointmentOptionCollection.find(query).toArray();
      const bookingQuery = { appointmentDate: date };
      const alreadyBooked = await bookingCollection
        .find(bookingQuery)
        .toArray();
      options.forEach((option) => {
        const optionBooked = alreadyBooked.filter(
          (book) => book.treatment === option.name
        );
        const bookedSlots = optionBooked.map((book) => book.slot);
        const remainingSlots = option.slots.filter(
          (slot) => !bookedSlots.includes(slot)
        );
        option.slots = remainingSlots;
      });
      res.send(options);
    });

    app.get("/v2/appointmentOptions", async (req, res) => {
      const date = req.query.date;
      const options = await appointmentOptionCollection
        .aggregate([
          {
            $lookup: {
              from: "bookings",
              localField: "name",
              foreignField: "treatment",
              as: "booked",
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $eq: ["$appointmentDate", date],
                    },
                  },
                },
              ],
            },
          },
          {
            $project: {
              name: 1,
              slots: 1,
              price: 1,
              booked: {
                $map: {
                  input: "$booked",
                  as: "book",
                  in: "$$book.slot",
                },
              },
            },
          },
          {
            $project: {
              name: 1,
              price:1,
              slots: {
                $setDifference: ["$slots", "$booked"],
              },
            },
          },
        ])
        .toArray();
      res.send(options);
    });

    //temporary update to price field
    // app.get('/addPrice', async(req,res)=>{
    //   const filter = {};
    //   const option = {upsert: true};
    //   const updateDoc = {
    //     $set: {
    //       price: 99,
    //     },
    //   };
    //   const result = await appointmentOptionCollection.updateMany(filter, updateDoc, option);
    //   res.send(result);
    // })

    app.get("/bookings", async (req, res) => {
      const email = req.query.email;
      const decodedEmail = req.decoded.email;
      // if (email !== decodedEmail) {
      //   return res.status(403).send({ message: "Forbidden Access" });
      // }
      const query = { email: email };
      const bookings = await bookingCollection.find(query).toArray();
      res.send(bookings);
    });

    app.get('/bookings/:id', async (req, res)=>{
      const id = req.params.id;
      const query = {_id: new ObjectId(id)}
      const result = await bookingCollection.findOne(query);
      res.send(result);
    })

    app.post("/bookings", async (req, res) => {
      const booking = req.body;
      const query = {
        appointmentDate: booking.appointmentDate,
        treatment: booking.treatment,
        email: booking.email,
      };
      const alreadyBooked = await bookingCollection.find(query).toArray();
      if (alreadyBooked.length) {
        const message = `You Already have a booking on ${booking.appointmentDate}`;
        return res.send({ acknowledged: false, message });
      }

      const result = await bookingCollection.insertOne(booking);
      res.send(result);
    });

    app.post('/create-payment-intent', async(req,res)=>{
      const booking = req.body;
      const price = booking.price;
      const amount = price * 100;

      const paymentIntent = await stripe.paymentIntents.create({
         currency: 'usd',
         amount: amount,
         "payment_method_types": [
          "card",
        ],
      });
      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    app.post('/payments', async(req,res)=>{
      const payments = req.body;
      const result = await paymentsCollection.insertOne(payments);
      const id = payments.bookingId;
      const filter = {_id: new ObjectId(id)};
      const updateDoc = {
        $set: {
          paid: true,
          transactionId: payments.transactionId
        }
      }
      const updateResult = await bookingCollection.updateOne(filter, updateDoc)
      res.send(result);
    });

    app.get("/jwt", async (req, res) => {
      const email = req.query.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      if (user) {
        const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, {
          expiresIn: "1h",
        });
        return res.send({ accessToken: token });
      }
      console.log(user);
      res.status(401).send({ accessToken: "" });
    });

    app.post("/users", async (req, res) => {
      const users = req.body;
      const result = await usersCollection.insertOne(users);
      res.send(result);
    });

    app.get("/users", verifyJWT, async (req, res) => {
      const query = {};
      const users = await usersCollection.find(query).toArray();
      res.send(users);
    });

    app.delete('/users/:id',verifyJWT, veriFyAdmin, async(req,res)=>{
      const id = req.params.id;
      const query = {_id: new ObjectId(id)}
      const result = await usersCollection.deleteOne(query);
      res.send(result);
    });

    app.get("/users/admin/:email", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ isAdmin: user?.role === "admin" });
    });

    app.get('/specialty', async(req, res)=>{
      const query = {};
      const result = await appointmentOptionCollection.find(query).project({name: 1}).toArray();
      res.send(result);
    })

    app.post('/doctors',verifyJWT, veriFyAdmin, async(req, res)=>{
      const doctors = req.body;
      const result = await doctorsCollection.insertOne(doctors);
      res.send(result);
    })

    app.get('/doctors',verifyJWT, veriFyAdmin, veriFyAdmin, async(req, res)=>{
      const query = {};
      const result = await doctorsCollection.find(query).toArray();
      res.send(result);
    })

    app.delete('/doctors/:id',verifyJWT,veriFyAdmin, async(req,res)=>{
      const id = req.params.id;
      const query = {_id: new ObjectId(id)}
      const result = await doctorsCollection.deleteOne(query);
      res.send(result);
    })

    app.put("/users/admin/:id", verifyJWT, veriFyAdmin, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const option = { upsert: true };
      const updateDoc = {
        $set: {
          role: "admin",
        },
      };
      const result = await usersCollection.updateOne(filter, updateDoc, option);
      res.send(result);
    });
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", async (req, res) => {
  res.send("Doctor portal server is running");
});

app.listen(port, () => console.log(`Doctors portal running on port ${port}`));
