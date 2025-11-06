const express = require('express');
const router = express.Router();
const multer = require('multer');
const archiver = require('archiver');
const Case = require('../models/case');
const User = require('../models/user');
const Policy = require('../models/policy'); // Import the Policy model
const { uploadDocumentToBlockchain, downloadDocumentFromBlockchain } = require('../services/blockchain.service.js');
// We no longer need uuid or createPolicyOnBlockchain here

const documentStorage = multer.memoryStorage();
const uploadDocuments = multer({
  storage: documentStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'image/jpeg', 'image/png', 'image/gif', 'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain', 'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type.'), false);
    }
  }
});

// Auth middleware for all investigator routes
router.use('/investigator', (req, res, next) => {
  if (req.session.userId && req.session.userRole === 'investigator') {
    next();
  } else {
    res.redirect('/login');
  }
});

// GET all cases
router.get("/investigator/cases", async (req, res) => {
  try {
    const cases = await Case.find({ assignedTo: req.session.userId })
                            .sort({ createdAt: -1 });
    res.render("investigator/cases", { cases });
  } catch (error) {
    res.status(500).send("Error fetching cases");
  }
});

// GET new case form (NOW FETCHES POLICIES)
router.get("/investigator/cases/new", async (req, res) => {
  try {
    // Fetch all policies from MongoDB to show in a dropdown
    const policies = await Policy.find({}).sort({ name: 1 });
    res.render("investigator/create-case", { 
      error: null,
      policies: policies // Pass the policies to the EJS template
    });
  } catch (error) {
    console.error('Error fetching policies:', error);
    res.render("investigator/create-case", { 
      error: "Could not load access policies. Please contact admin.",
      policies: [] 
    });
  }
});

// POST new case (NOW USES A SELECTED POLICY)
router.post("/investigator/cases/new", uploadDocuments.array('documents', 5), async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    const caseNumber = 'CASE-' + Date.now();
    const orgMspId = req.session.orgMspId;
    
    // Get the selected policyId and validate
    const { title, description, priority, policyId } = req.body;
    
    if (!policyId) {
      const policies = await Policy.find({}).sort({ name: 1 });
      return res.render("investigator/create-case", { 
        error: "Please select an access policy",
        policies
      });
    }

    // Verify policy exists
    const selectedPolicy = await Policy.findById(policyId);
    if (!selectedPolicy) {
      const policies = await Policy.find({}).sort({ name: 1 });
      return res.render("investigator/create-case", { 
        error: "Selected policy not found",
        policies
      });
    }

    // Create case with policy reference
    const newCase = new Case({
      caseNumber,
      title,
      description,
      priority,
      assignedTo: req.session.userId,
      jurisdiction: user.jurisdiction,
      policyId: selectedPolicy._id,
      documents: []
    });

    await newCase.save();

    // Upload documents with the selected policy
    if (req.files && req.files.length > 0) {
      const documentPromises = req.files.map(async file => {
        const recordId = await uploadDocumentToBlockchain(
          file,
          newCase._id.toString(),
          orgMspId,
          'Evidence',
          selectedPolicy.policyId // Use the policy's blockchain ID
        );

        return {
          name: file.originalname,
          contentType: file.mimetype,
          recordId: recordId
        };
      });

      const documents = await Promise.all(documentPromises);
      newCase.documents = documents;
      await newCase.save();
    }

    res.redirect('/investigator/cases');
  } catch (error) {
    console.error('Case creation error:', error);
    const policies = await Policy.find({}).sort({ name: 1 });
    res.render("investigator/create-case", { 
      error: "Error creating case: " + (error.message || "Please try again."),
      policies
    });
  }
});

// GET case details
router.get("/investigator/cases/:id", async (req, res) => {
  try {
    const case_ = await Case.findOne({
      _id: req.params.id,
      assignedTo: req.session.userId
    })
    .populate('policyId', 'name'); // Show the policy name in the details page
    
    if (!case_) {
      return res.status(404).send("Case not found");
    }
    res.render("investigator/case-details", { case_ });
  } catch (error) {
    console.error(error);
    res.status(500).send("Error fetching case details");
  }
});

// GET (Download) single document
router.get("/investigator/cases/:caseId/documents/:docId", async (req, res) => {
  try {
    const case_ = await Case.findOne({
      _id: req.params.caseId,
      assignedTo: req.session.userId
    });
    if (!case_) return res.status(404).send("Case not found");

    const document = case_.documents.id(req.params.docId);
    if (!document) return res.status(404).send("Document not found");

    // Fetch from blockchain
    const fileBuffer = await downloadDocumentFromBlockchain(
      document.recordId,
      req.session.orgMspId
    );

    // Send to user
    res.set('Content-Type', document.contentType);
    res.set('Content-Disposition', `attachment; filename="${document.name}"`);
    res.send(fileBuffer);
  } catch (error) {
    console.error(error);
    res.status(500).send(error.message);
  }
});

// GET (Download) .zip of all case documents
router.get("/investigator/cases/:id/download", async (req, res) => {
  try {
    const case_ = await Case.findOne({
      _id: req.params.id,
      assignedTo: req.session.userId
    });
    if (!case_) return res.status(404).send("Case not found");

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename=Case-${case_.caseNumber}.zip`
    });
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    // Add case details text file
    const caseDetails = `Case Number: ${case_.caseNumber}
Title: ${case_.title}
Description: ${case_.description}
Priority: ${case_.priority}
Status: ${case_.status}
Created At: ${case_.createdAt}
Last Updated: ${case_.updatedAt}

Updates:
${case_.updates ? case_.updates.map(update => 
  `[${new Date(update.timestamp).toLocaleString()}] ${update.text}`
).join('\n') : 'No updates'}
`;
    archive.append(caseDetails, { name: 'case-details.txt' });

    // Add all documents from blockchain
    if (case_.documents && case_.documents.length > 0) {
      for (const doc of case_.documents) {
        try {
          const fileBuffer = await downloadDocumentFromBlockchain(
            doc.recordId,
            req.session.orgMspId
          );
          archive.append(fileBuffer, { 
            name: `documents/${doc.name}`,
            date: doc.uploadedAt || new Date()
          });
        } catch (err) {
          // Add a failure receipt to the zip
          archive.append(`FAILED_TO_DOWNLOAD: ${err.message}`, { 
            name: `documents/FAILED_${doc.name}.txt` 
          });
        }
      }
    }
    
    await archive.finalize();
  } catch (error) {
    console.error('Case download error:', error);
    res.status(500).send("Error downloading case");
  }
});

// POST update case status
router.post("/investigator/cases/:id/status", async (req, res) => {
  try {
    await Case.findOneAndUpdate(
      { _id: req.params.id, assignedTo: req.session.userId },
      { status: req.body.status, updatedAt: new Date() }
    );
    res.redirect(`/investigator/cases/${req.params.id}`);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error updating case status");
  }
});

// POST add case update
router.post("/investigator/cases/:id/update", async (req, res) => {
  try {
    await Case.findOneAndUpdate(
      { _id: req.params.id, assignedTo: req.session.userId },
      { 
        $push: { 
          updates: {
            text: req.body.updateText,
            timestamp: new Date(),
            updatedBy: req.session.userId
          }
        },
        updatedAt: new Date()
      }
    );
    res.redirect(`/investigator/cases/${req.params.id}`);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error adding case update");
  }
});

// POST upload additional documents (NOW USES EXISTING POLICY)
router.post("/investigator/cases/:id/documents", uploadDocuments.array('documents', 5), async (req, res) => {
  try {
    const caseId = req.params.id;
    
    // Find the case in Mongo
    const case_ = await Case.findOne({
      _id: caseId,
      assignedTo: req.session.userId
    });
    if (!case_) {
      return res.status(404).send("Case not found");
    }

    // Get the *existing* policyId from the case
    const existingPolicyId = case_.policyId;
    if (!existingPolicyId) {
      // This should not happen if the "new case" route is correct
      return res.status(500).send("Case has no policyId. Cannot add documents.");
    }
    
    const documentLinks = [];
    const uploadErrors = [];

    if (req.files) {
      for (const file of req.files) {
        try {
          // Use the case's existing policyId
          const recordId = await uploadDocumentToBlockchain(
            file,
            caseId,
            req.session.orgMspId,
            'Evidence',
            existingPolicyId // Use the existing policy ID
          );
          documentLinks.push({
            name: file.originalname,
            contentType: file.mimetype,
            recordId: recordId
          });
        } catch (err) {
          uploadErrors.push(err.message);
        }
      }
    }

    // Add new document links to Mongo case
    await Case.findOneAndUpdate(
      { _id: caseId, assignedTo: req.session.userId },
      { $push: { documents: { $each: documentLinks } }, updatedAt: new Date() }
    );

    if (uploadErrors.length > 0) {
      // Handle partial failure (redirect with an error message)
      // You can use flash messages here
    }

    res.redirect(`/investigator/cases/${caseId}`);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error uploading documents");
  }
});

// POST delete document
router.post("/investigator/cases/:caseId/documents/:docId/delete", async (req, res) => {
  try {
    // Note: This only deletes the *reference* from MongoDB.
    // The data on the blockchain is immutable. This is expected.
    await Case.findOneAndUpdate(
      { _id: req.params.caseId, assignedTo: req.session.userId },
      { $pull: { documents: { _id: req.params.docId } }, updatedAt: new Date() }
    );
    res.redirect(`/investigator/cases/${req.params.caseId}`);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error deleting document");
  }
});

module.exports = router;