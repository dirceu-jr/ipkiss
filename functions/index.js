const { setGlobalOptions } = require("firebase-functions");
const { onRequest } = require("firebase-functions/https");

// for Firestore
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

// Mandatory for Firestore
initializeApp();
const db = getFirestore();

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
setGlobalOptions({ maxInstances: 10 });

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

exports.reset = onRequest(async (request, response) => {
  if (request.method !== "POST") {
    response.status(405).send({ status: "Method Not Allowed." });
    return;
  }

  try {
    const accounts = db.collection("accounts");

    // Get all documents in the accounts collection
    const snapshot = await accounts.get();

    // Create a batch to delete all documents
    const batch = db.batch();

    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    // Commit the batch delete
    await batch.commit();

    response.send("OK");
  } catch (error) {
    console.error("Error deleting accounts:", error);
    response.status(500).send("Error deleting accounts");
  }
});

exports.balance = onRequest(async (request, response) => {
  if (request.method !== "GET") {
    response.status(405).send({ status: "Method Not Allowed." });
    return;
  }

  const account_id = request.query.account_id;

  if (!account_id) {
    response.status(400).send({ status: "Missing account ID." });
    return;
  }

  const accounts = db.collection("accounts");
  const accountRef = accounts.doc(account_id);
  const accountSnapshot = await accountRef.get();

  if (!accountSnapshot.exists) {
    response.status(404).send("0");
    return;
  }

  response.send(accountSnapshot.data().balance.toString());
});

exports.event = onRequest(async (request, response) => {
  if (request.method !== "POST") {
    response.status(405).send({ status: "Method Not Allowed." });
    return;
  }

  const eventType = request.body.type;
  const accounts = db.collection("accounts");

  if (eventType == "deposit") {
    const destination = request.body.destination;
    const amount = request.body.amount;

    if (!destination || !amount) {
      response.status(400).send({ status: "Missing destination or amount." });
      return;
    }

    const accountRef = accounts.doc(destination);
    const accountSnapshot = await accountRef.get();

    if (!accountSnapshot.exists) {
      // create a new account if it does not exist
      await accountRef.set({ balance: amount });
      response.status(201).send({ destination: { id: destination, balance: amount } });
    } else {
      const currentBalance = accountSnapshot.data().balance || 0;
      const newBalance = currentBalance + amount;

      await accountRef.update({ balance: newBalance });
      response.status(201).send({ destination: { id: destination, balance: newBalance } });
    }

  } else if (eventType == "withdraw") {
    const origin = request.body.origin;
    const amount = request.body.amount;

    if (!origin || !amount) {
      response.status(400).send({ status: "Missing origin or amount." });
      return;
    }

    const accountRef = accounts.doc(origin);
    const accountSnapshot = await accountRef.get();

    if (!accountSnapshot.exists) {
      response.status(404).send("0");
      return;
    }

    const currentBalance = accountSnapshot.data().balance || 0;
    if (currentBalance < amount) {
      response.status(400).send({ status: "Insufficient funds." });
      return;
    }

    const newBalance = currentBalance - amount;
    await accountRef.update({ balance: newBalance });
    response.status(201).send({ origin: { id: origin, balance: newBalance } });

  } else if (eventType == "transfer") {
    const origin = request.body.origin;
    const amount = request.body.amount;
    const destination = request.body.destination;

    if (!origin || !amount || !destination) {
      response.status(400).send({ status: "Missing origin, amount, or destination." });
      return;
    }

    // Use Firestore transaction for atomicity
    try {
      const result = await db.runTransaction(async (transaction) => {
        const originRef = accounts.doc(origin);
        const destinationRef = accounts.doc(destination);
        
        const originDoc = await transaction.get(originRef);
        let destinationDoc = await transaction.get(destinationRef);

        if (!originDoc.exists) {
          throw new Error("ORIGIN_NOT_FOUND");
        }

        const originBalance = originDoc.data().balance || 0;
        if (originBalance < amount) {
          throw new Error("INSUFFICIENT_FUNDS");
        }

        // Create destination account if it doesn't exist
        if (!destinationDoc.exists) {
          transaction.set(destinationRef, { balance: 0 });
          destinationDoc = { data: () => ({ balance: 0 }) };
        }

        const destinationBalance = destinationDoc.data().balance || 0;
        const newOriginBalance = originBalance - amount;
        const newDestinationBalance = destinationBalance + amount;

        transaction.update(originRef, { balance: newOriginBalance });
        transaction.update(destinationRef, { balance: newDestinationBalance });

        return {
          origin: { id: origin, balance: newOriginBalance },
          destination: { id: destination, balance: newDestinationBalance }
        };
      });

      response.status(201).send(result);
    } catch (error) {
      if (error.message === "ORIGIN_NOT_FOUND") {
        response.status(404).send("0");
      } else if (error.message === "INSUFFICIENT_FUNDS") {
        response.status(400).send({ status: "Insufficient funds." });
      } else {
        console.error("Transaction failed:", error);
        response.status(500).send({ status: "Transaction failed." });
      }
    }
  } else {
    response.status(400).send({ status: "Invalid event type." });
    return;
  }
});
