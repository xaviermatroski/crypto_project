const express = require("express");
const bodyParser = require("body-parser");
const ejs = require("ejs");
const nodemailer = require("nodemailer");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const bcrypt = require("bcrypt"); // Add bcrypt for password hashing
const sharp = require('sharp'); // Add sharp require at the top with other requires
require("dotenv").config();

const app = express();

app.set("view engine", "ejs");

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use(express.json())

// Database
const mongoose = require('mongoose');

// Database connection
mongoose.connect('mongodb://127.0.0.1:27017/criminaldb', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log("Connected to MongoDB locally"))
.catch(err => console.error("MongoDB connection error:", err));

// Import models
const User = require('./models/user');
const Case = require('./models/case');
const Jurisdiction = require('./models/jurisdiction');

// Create admin user if not exists
async function createAdmin() {
  try {
    const adminExists = await User.findOne({ email: 'admin@cdms.com' });
    if (!adminExists) {
      const admin = new User({
        userName: 'admin',
        email: 'admin@cdms.com',
        password: 'admin123', // Will be hashed automatically
        phone: '9999999999',
        role: 'admin',
        address: {
          street: 'HQ Street',
          city: 'Delhi',
          state: 'Delhi',
          zipCode: '110001'
        }
      });
      await admin.save();
      console.log('Admin user created successfully');
    }
  } catch (error) {
    console.error('Error creating admin:', error);
  }
}
createAdmin();

// Session middleware
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // set to true in production with HTTPS
}));

// Multer configurations
const profileStorage = multer.memoryStorage();
const documentStorage = multer.memoryStorage();

// Profile picture upload config
const uploadProfile = multer({
  storage: profileStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Please upload an image file'), false);
    }
  }
});

// Case documents upload config
const uploadDocuments = multer({
  storage: documentStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed types: Images, PDF, DOC, DOCX, TXT, XLS, XLSX'), false);
    }
  }
});

// Routes
app.get("/", (req, res) => {
  res.render("home");
});

app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  try {
    const user = await User.findOne({ email: req.body.email }).select('+password');
    if (!user) {
      return res.render("login", { error: "Invalid credentials" });
    }

    const validPassword = await bcrypt.compare(req.body.password, user.password);
    if (!validPassword) {
      return res.render("login", { error: "Invalid credentials" });
    }

    // Check if user is blocked
    if (user.isUserBlocked()) {
      return res.render("login", { error: user.getBlockedMessage() });
    }

    if (!user.isApproved && user.role !== 'admin') {
      return res.render("login", { error: "Your account is pending approval" });
    }

    req.session.userId = user._id;
    req.session.userRole = user.role;

    // Role-based redirection
    switch (user.role) {
      case 'admin':
        res.redirect('/admin/dashboard');
        break;
      case 'investigator':
        res.redirect('/investigator/dashboard');
        break;
      case 'forensics_officer':
        res.redirect('/forensics/dashboard');
        break;
      default:
        res.redirect('/');
    }
  } catch (error) {
    console.error('Login error:', error);
    res.render("login", { error: "An error occurred" });
  }
});

app.get("/admin/dashboard", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'admin') {
    try {
      const admin = await User.findById(req.session.userId);
      const totalUsers = await User.countDocuments({ role: { $ne: 'admin' } });
      const totalCases = await Case.countDocuments();
      const activeCases = await Case.countDocuments({ status: { $ne: 'closed' } });

      // Cases by Jurisdiction - Improved aggregation
      const casesByJurisdiction = await Case.aggregate([
        {
          $lookup: {
            from: 'users',
            localField: 'assignedTo',
            foreignField: '_id',
            as: 'assignedUser'
          }
        },
        { $unwind: '$assignedUser' },
        {
          $match: {
            'assignedUser.role': { $ne: 'admin' }  // Exclude admin users
          }
        },
        {
          $group: {
            _id: {
              district: '$assignedUser.jurisdiction.district',
              state: '$assignedUser.jurisdiction.state'
            },
            count: { $sum: 1 }
          }
        },
        {
          $project: {
            _id: 0,
            jurisdiction: { 
              $concat: [
                '$_id.district', 
                ' (', 
                '$_id.state', 
                ')'
              ] 
            },
            count: 1
          }
        },
        { $sort: { jurisdiction: 1 } }
      ]);

      // User Roles Distribution - Exclude admin
      const userRoles = await User.aggregate([
        {
          $match: {
            role: { $ne: 'admin' }
          }
        },
        {
          $group: {
            _id: '$role',
            count: { $sum: 1 }
          }
        },
        {
          $project: {
            _id: 0,
            role: {
              $switch: {
                branches: [
                  { case: { $eq: ['$_id', 'investigator'] }, then: 'Investigators' },
                  { case: { $eq: ['$_id', 'forensics_officer'] }, then: 'Forensics Officers' }
                ],
                default: '$_id'
              }
            },
            count: 1
          }
        },
        { $sort: { role: 1 } }
      ]);

      // Cases Timeline (last 6 months)
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      
      const casesTimeline = await Case.aggregate([
        {
          $match: {
            createdAt: { $gte: sixMonthsAgo }
          }
        },
        {
          $group: {
            _id: {
              month: { $month: '$createdAt' },
              year: { $year: '$createdAt' }
            },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
      ]);

      const chartData = {
        jurisdictions: {
          labels: casesByJurisdiction.map(j => j.jurisdiction),
          data: casesByJurisdiction.map(j => j.count)
        },
        roles: {
          labels: userRoles.map(r => r.role),
          data: userRoles.map(r => r.count)
        },
        timeline: {
          labels: casesTimeline.map(t => `${t._id.month}/${t._id.year}`),
          data: casesTimeline.map(t => t.count)
        }
      };

      res.render("admin/dashboard", { 
        admin,
        stats: { totalUsers, totalCases, activeCases },
        chartData
      });
    } catch (error) {
      console.error(error);
      res.status(500).send("Error fetching dashboard data");
    }
  } else {
    res.redirect('/login');
  }
});

// Add role-specific dashboard routes
app.get("/investigator/dashboard", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'investigator') {
    try {
      const user = await User.findById(req.session.userId);
      
      // Get statistics
      const totalCases = await Case.countDocuments({ assignedTo: req.session.userId });
      const activeCases = await Case.countDocuments({ 
        assignedTo: req.session.userId,
        status: { $ne: 'closed' }
      });
      const solvedCases = await Case.countDocuments({ 
        assignedTo: req.session.userId,
        status: 'closed'
      });

      // Cases by Priority
      const casesByPriority = await Case.aggregate([
        {
          $match: { assignedTo: user._id }
        },
        {
          $group: {
            _id: '$priority',
            count: { $sum: 1 }
          }
        }
      ]);

      // Cases by Status
      const casesByStatus = await Case.aggregate([
        {
          $match: { assignedTo: user._id }
        },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ]);

      // Cases Timeline (last 6 months)
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      
      const casesTimeline = await Case.aggregate([
        {
          $match: {
            assignedTo: user._id,
            createdAt: { $gte: sixMonthsAgo }
          }
        },
        {
          $group: {
            _id: {
              month: { $month: '$createdAt' },
              year: { $year: '$createdAt' }
            },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
      ]);

      const chartData = {
        priority: {
          labels: casesByPriority.map(p => p._id || 'Unspecified'),
          data: casesByPriority.map(p => p.count)
        },
        status: {
          labels: casesByStatus.map(s => s._id || 'New'),
          data: casesByStatus.map(s => s.count)
        },
        timeline: {
          labels: casesTimeline.map(t => `${t._id.month}/${t._id.year}`),
          data: casesTimeline.map(t => t.count)
        }
      };

      res.render("investigator/dashboard", { 
        user,
        stats: {
          totalCases,
          activeCases,
          solvedCases
        },
        chartData
      });
    } catch (error) {
      console.error(error);
      res.status(500).send("Error fetching dashboard data");
    }
  } else {
    res.redirect('/login');
  }
});

app.get("/forensics/dashboard", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'forensics_officer') {
    const user = await User.findById(req.session.userId);
    res.render("forensics/dashboard", { user });
  } else {
    res.redirect('/login');
  }
});

// Logout route
app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.log(err);
    res.redirect('/login');
  });
});

// Admin user management routes
app.get("/admin/users", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'admin') {
    try {
      const approvedUsers = await User.find({ 
        _id: { $ne: req.session.userId },
        isApproved: true 
      });
      const pendingUsers = await User.find({ isApproved: false });
      const jurisdictions = await Jurisdiction.find({}).sort({ state: 1, district: 1 });
      res.render("admin/users", { approvedUsers, pendingUsers, jurisdictions });
    } catch (error) {
      console.error(error);
      res.status(500).send("Error fetching users");
    }
  } else {
    res.redirect('/login');
  }
});

// Add jurisdiction management routes
app.get("/admin/jurisdictions", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'admin') {
    try {
      const jurisdictions = await Jurisdiction.find({}).sort({ state: 1, district: 1 });
      res.render("admin/jurisdictions", { jurisdictions, error: null });
    } catch (error) {
      console.error(error);
      res.status(500).send("Error fetching jurisdictions");
    }
  } else {
    res.redirect('/login');
  }
});

app.post("/admin/jurisdictions/add", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'admin') {
    try {
      const jurisdiction = new Jurisdiction(req.body);
      await jurisdiction.save();
      res.redirect('/admin/jurisdictions');
    } catch (error) {
      console.error(error);
      res.render("admin/jurisdictions", { 
        error: "Error adding jurisdiction. It might already exist.",
        jurisdictions: await Jurisdiction.find({})
      });
    }
  } else {
    res.redirect('/login');
  }
});

// Update approval route
app.post("/admin/users/approve/:id", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'admin') {
    try {
      await User.findByIdAndUpdate(req.params.id, {
        isApproved: true,
        jurisdiction: req.body.jurisdiction
      });
      res.redirect('/admin/users');
    } catch (error) {
      console.error(error);
      res.status(500).send("Error approving user");
    }
  } else {
    res.redirect('/login');
  }
});

// Add rejection route
app.post("/admin/users/reject/:id", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'admin') {
    try {
      await User.findByIdAndDelete(req.params.id);
      res.redirect('/admin/users');
    } catch (error) {
      console.error(error);
      res.status(500).send("Error rejecting user");
    }
  } else {
    res.redirect('/login');
  }
});

// Update user jurisdiction
app.post("/admin/users/:id/update-jurisdiction", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'admin') {
    try {
      await User.findByIdAndUpdate(req.params.id, {
        jurisdiction: JSON.parse(req.body.jurisdiction)
      });
      res.redirect('/admin/users');
    } catch (error) {
      console.error(error);
      res.status(500).send("Error updating jurisdiction");
    }
  } else {
    res.redirect('/login');
  }
});

// Toggle user active status
app.post("/admin/users/:id/toggle-status", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'admin') {
    try {
      const user = await User.findById(req.params.id);
      if (!user) {
        return res.status(404).send("User not found");
      }

      const updates = {
        isBlocked: !user.isBlocked,
        blockedAt: !user.isBlocked ? new Date() : null,
        blockedReason: !user.isBlocked ? req.body.reason : null
      };

      await User.findByIdAndUpdate(req.params.id, updates);

      // Force logout if user is being blocked
      if (!user.isBlocked) {
        // Clear any existing sessions for the blocked user
        // This depends on your session store implementation
        // Here's a basic example:
        if (req.session.userId === user._id) {
          req.session.destroy();
        }
      }

      res.redirect('/admin/users');
    } catch (error) {
      console.error(error);
      res.status(500).send("Error toggling user status");
    }
  } else {
    res.redirect('/login');
  }
});

// Delete user
app.post("/admin/users/:id/delete", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'admin') {
    try {
      await User.findByIdAndDelete(req.params.id);
      res.redirect('/admin/users');
    } catch (error) {
      console.error(error);
      res.status(500).send("Error deleting user");
    }
  } else {
    res.redirect('/login');
  }
});

// Registration routes
app.get("/register", (req, res) => {
  res.render("register", { error: null });
});

app.post("/register", uploadProfile.single('profilePicture'), async (req, res) => {
  try {
    // Process profile picture if uploaded
    if (req.file) {
      const resizedImage = await sharp(req.file.buffer)
        .resize(200, 200, { fit: 'cover' })
        .toBuffer();
      req.body.profilePicture = {
        data: resizedImage,
        contentType: req.file.mimetype
      };
    }

    // Create new user
    const user = new User({
      ...req.body,
      isApproved: false
    });

    await user.save();
    res.render("registration-success");
  } catch (error) {
    let errorMessage = "Registration failed";
    if (error.code === 11000) {
      errorMessage = "Username or email already exists";
    }
    res.render("register", { error: errorMessage });
  }
});

// Case management routes
app.get("/investigator/cases", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'investigator') {
    try {
      const cases = await Case.find({ assignedTo: req.session.userId })
                             .sort({ createdAt: -1 });
      res.render("investigator/cases", { cases });
    } catch (error) {
      res.status(500).send("Error fetching cases");
    }
  } else {
    res.redirect('/login');
  }
});

app.get("/investigator/cases/new", (req, res) => {
  if (req.session.userId && req.session.userRole === 'investigator') {
    res.render("investigator/create-case", { error: null });
  } else {
    res.redirect('/login');
  }
});

app.post("/investigator/cases/new", uploadDocuments.array('documents', 5), async (req, res) => {
  if (req.session.userId && req.session.userRole === 'investigator') {
    try {
      const caseNumber = 'CASE-' + Date.now();
      const documents = req.files ? req.files.map(file => ({
        name: file.originalname,
        data: file.buffer,
        contentType: file.mimetype
      })) : [];

      const newCase = new Case({
        caseNumber,
        title: req.body.title,
        description: req.body.description,
        priority: req.body.priority,
        assignedTo: req.session.userId,
        documents
      });

      await newCase.save();
      res.redirect('/investigator/cases');
    } catch (error) {
      console.error('Case creation error:', error);
      res.render("investigator/create-case", { 
        error: "Error creating case. " + (error.message || "Please try again.")
      });
    }
  } else {
    res.redirect('/login');
  }
});

// Case details route
app.get("/investigator/cases/:id", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'investigator') {
    try {
      const case_ = await Case.findOne({
        _id: req.params.id,
        assignedTo: req.session.userId
      });
      if (!case_) {
        return res.status(404).send("Case not found");
      }
      res.render("investigator/case-details", { case_ });
    } catch (error) {
      console.error(error);
      res.status(500).send("Error fetching case details");
    }
  } else {
    res.redirect('/login');
  }
});

// Document download route
app.get("/investigator/cases/:caseId/documents/:docId", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'investigator') {
    try {
      const case_ = await Case.findOne({
        _id: req.params.caseId,
        assignedTo: req.session.userId
      });
      
      if (!case_) {
        return res.status(404).send("Case not found");
      }

      const document = case_.documents.id(req.params.docId);
      if (!document) {
        return res.status(404).send("Document not found");
      }

      res.set('Content-Type', document.contentType);
      res.set('Content-Disposition', `attachment; filename="${document.name}"`);
      res.send(document.data);
    } catch (error) {
      console.error(error);
      res.status(500).send("Error downloading document");
    }
  } else {
    res.redirect('/login');
  }
});

// Update case status
app.post("/investigator/cases/:id/status", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'investigator') {
    try {
      await Case.findOneAndUpdate(
        { _id: req.params.id, assignedTo: req.session.userId },
        { status: req.body.status }
      );
      res.redirect(`/investigator/cases/${req.params.id}`);
    } catch (error) {
      console.error(error);
      res.status(500).send("Error updating case status");
    }
  } else {
    res.redirect('/login');
  }
});

// Add case update
app.post("/investigator/cases/:id/update", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'investigator') {
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
          }
        }
      );
      res.redirect(`/investigator/cases/${req.params.id}`);
    } catch (error) {
      console.error(error);
      res.status(500).send("Error adding case update");
    }
  } else {
    res.redirect('/login');
  }
});

// Upload additional documents
app.post("/investigator/cases/:id/documents", uploadDocuments.array('documents', 5), async (req, res) => {
  if (req.session.userId && req.session.userRole === 'investigator') {
    try {
      const documents = req.files ? req.files.map(file => ({
        name: file.originalname,
        data: file.buffer,
        contentType: file.mimetype,
        uploadedAt: new Date()
      })) : [];

      await Case.findOneAndUpdate(
        { _id: req.params.id, assignedTo: req.session.userId },
        { $push: { documents: { $each: documents } } }
      );
      res.redirect(`/investigator/cases/${req.params.id}`);
    } catch (error) {
      console.error(error);
      res.status(500).send("Error uploading documents");
    }
  } else {
    res.redirect('/login');
  }
});

// Delete document
app.post("/investigator/cases/:caseId/documents/:docId/delete", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'investigator') {
    try {
      await Case.findOneAndUpdate(
        { _id: req.params.caseId, assignedTo: req.session.userId },
        { $pull: { documents: { _id: req.params.docId } } }
      );
      res.redirect(`/investigator/cases/${req.params.caseId}`);
    } catch (error) {
      console.error(error);
      res.status(500).send("Error deleting document");
    }
  } else {
    res.redirect('/login');
  }
});

// Port opening
app.listen(3001, function() {
    console.log("Server started on port 3001");
});