const express = require("express");
const bodyParser = require("body-parser");
const ejs = require("ejs");
const nodemailer = require("nodemailer");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const bcrypt = require("bcrypt");
const sharp = require('sharp');
const fs = require('fs');
require("dotenv").config();

const app = express();

app.set("view engine", "ejs");

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use(express.json())

const mongoose = require('mongoose');

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 10000,
  dbName: process.env.MONGODB_DB_NAME
})
.then(() => console.log("Connected to MongoDB Atlas"))
.catch(err => {
  console.error("MongoDB connection error:", err);
  process.exit(1);
});

mongoose.connection.on('connected', () => {
  console.log('MongoDB connection established');
});
mongoose.connection.on('error', (err) => {
  console.error('MongoDB connection error:', err);
});
mongoose.connection.on('disconnected', () => {
  console.log('MongoDB connection disconnected');
});

// Update model imports
const User = require('./models/user');
const Case = require('./models/case');
const Jurisdiction = require('./models/jurisdiction');
const Policy = require('./models/policy'); // Add Policy model import

async function createAdmin() {
  try {
    const adminExists = await User.findOne({ email: 'admin@cdms.com' });
    if (!adminExists) {
      const admin = new User({
        userName: 'admin',
        email: 'admin@cdms.com',
        password: 'admin123',
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

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

const profileStorage = multer.memoryStorage();
const uploadProfile = multer({
  storage: profileStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Please upload an image file'), false);
    }
  }
});

// Import auth middleware
const { isAuthenticated, isAdmin, roleCheck } = require('./middlewares/auth');

app.get("/", (req, res) => {
  res.render("home");
});

app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

// Update login route
app.post("/login", async (req, res) => {
  try {
    // Validate input
    const { email, password } = req.body;
    if (!email || !password) {
      return res.render("login", { error: "Email and password are required" });
    }

    // Find user and include password field
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      return res.render("login", { error: "Invalid credentials" });
    }

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.render("login", { error: "Invalid credentials" });
    }

    // Check if user is blocked
    if (user.isBlocked) {
      return res.render("login", { 
        error: `Account is blocked. Reason: ${user.blockedReason || 'Contact administrator'}` 
      });
    }

    // Check approval status
    if (!user.isApproved && user.role !== 'admin') {
      return res.render("login", { error: "Your account is pending approval" });
    }

    // Set session
    req.session.userId = user._id;
    req.session.userRole = user.role;
    
    // Set organization based on jurisdiction
    if (user.jurisdiction && user.jurisdiction.district === 'DistrictPoliceA') {
      req.session.orgMspId = 'Org1MSP';
    } else if (user.jurisdiction && user.jurisdiction.district === 'DistrictPoliceB') {
      req.session.orgMspId = 'Org2MSP';
    } else if (user.role === 'forensics_officer') {
      req.session.orgMspId = 'Org2MSP';
    } else {
      req.session.orgMspId = 'Org1MSP';
    }

    // Role-based redirect
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
      case 'judiciary':
        res.redirect('/judiciary/dashboard');
        break;
      default:
        res.redirect('/');
    }
  } catch (error) {
    console.error('Login error:', error);
    res.render("login", { error: "An error occurred during login" });
  }
});

app.get("/admin/dashboard", isAdmin, async (req, res) => {
  if (req.session.userId && req.session.userRole === 'admin') {
    try {
      const admin = await User.findById(req.session.userId);
      const totalUsers = await User.countDocuments({ role: { $ne: 'admin' } });
      const totalCases = await Case.countDocuments();
      const activeCases = await Case.countDocuments({ status: { $ne: 'closed' } });

      const casesByJurisdiction = await Case.aggregate([
        { $match: { 'jurisdiction.district': { $exists: true, $ne: null } } },
        { $group: { _id: '$jurisdiction.district', count: { $sum: 1 } } },
        { $project: { _id: 0, jurisdiction: { $ifNull: ['$_id', 'Unassigned'] }, count: 1 } },
        { $sort: { jurisdiction: 1 } }
      ]);

      const userRoles = await User.aggregate([
        { $match: { role: { $ne: 'admin' } } },
        { $group: { _id: '$role', count: { $sum: 1 } } },
        { $project: {
            role: {
              $switch: {
                branches: [
                  { case: { $eq: ['$_id', 'investigator'] }, then: 'Investigators' },
                  { case: { $eq: ['$_id', 'forensics_officer'] }, then: 'Forensics Officers' },
                  { case: { $eq: ['$_id', 'judiciary'] }, then: 'Judiciary' }
                ],
                default: '$_id'
              }
            },
            count: 1
          }
        },
        { $sort: { role: 1 } }
      ]);

      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      
      const casesTimeline = await Case.aggregate([
        { $match: { createdAt: { $gte: sixMonthsAgo } } },
        { $group: {
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

app.get("/investigator/dashboard", roleCheck(['investigator']), async (req, res) => {
  if (req.session.userId && req.session.userRole === 'investigator') {
    try {
      const user = await User.findById(req.session.userId);
      
      const totalCases = await Case.countDocuments({ assignedTo: req.session.userId });
      const activeCases = await Case.countDocuments({ 
        assignedTo: req.session.userId,
        status: { $ne: 'closed' }
      });
      const solvedCases = await Case.countDocuments({ 
        assignedTo: req.session.userId,
        status: 'closed'
      });

      const casesByPriority = await Case.aggregate([
        { $match: { assignedTo: user._id } },
        { $group: { _id: '$priority', count: { $sum: 1 } } }
      ]);

      const casesByStatus = await Case.aggregate([
        { $match: { assignedTo: user._id } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);

      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      
      const casesTimeline = await Case.aggregate([
        { $match: {
            assignedTo: user._id,
            createdAt: { $gte: sixMonthsAgo }
          }
        },
        { $group: {
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

app.get("/forensics/dashboard", roleCheck(['forensics_officer']), async (req, res) => {
  if (req.session.userId && req.session.userRole === 'forensics_officer') {
    const user = await User.findById(req.session.userId);
    res.render("forensics/dashboard", { user });
  } else {
    res.redirect('/login');
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.log(err);
    res.redirect('/login');
  });
});

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
      const jurisdictions = await Jurisdiction.find({});
      res.render("admin/jurisdictions", { 
        error: "Error adding jurisdiction. It might already exist.",
        jurisdictions: jurisdictions
      });
    }
  } else {
    res.redirect('/login');
  }
});

app.post("/admin/users/approve/:id", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'admin') {
    try {
      const user = await User.findById(req.params.id);
      if (!user) {
        return res.status(404).send("User not found");
      }

      // Initialize update data
      const updateData = {
        isApproved: true,
        approvedAt: new Date(),
        approvedBy: req.session.userId
      };

      // Handle jurisdiction based on role
      if (user.role !== 'judiciary') {
        try {
          if (!req.body.jurisdiction) {
            return res.status(400).send("Jurisdiction is required for this role");
          }
          updateData.jurisdiction = typeof req.body.jurisdiction === 'string' ? 
            JSON.parse(req.body.jurisdiction) : req.body.jurisdiction;
        } catch (e) {
          console.error('Jurisdiction parsing error:', e);
          return res.status(400).send("Invalid jurisdiction format");
        }
      }

      // Update user
      const updatedUser = await User.findByIdAndUpdate(
        req.params.id,
        updateData,
        { new: true, runValidators: true }
      );

      if (!updatedUser) {
        return res.status(500).send("Error updating user");
      }

      // Send success response
      res.redirect('/admin/users');
    } catch (error) {
      console.error('User approval error:', error);
      res.status(500).send(`Error approving user: ${error.message}`);
    }
  } else {
    res.redirect('/login');
  }
});

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

      if (!user.isBlocked) {
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

app.get("/register", (req, res) => {
  res.render("register", { error: null });
});

// Update registration route
app.post("/register", uploadProfile.single('profilePicture'), async (req, res) => {
  try {
    // Validate required fields
    const { userName, email, password, role, phone } = req.body;
    if (!userName || !email || !password || !role || !phone) {
      return res.render("register", { error: "All fields are required" });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ 
      $or: [{ email: email }, { userName: userName }] 
    });
    
    if (existingUser) {
      return res.render("register", { 
        error: "User with this email or username already exists" 
      });
    }

    // Create user object
    const userData = {
      userName,
      email,
      password, // Will be hashed by the model pre-save hook
      phone,
      role,
      address: req.body.address,
      isApproved: false
    };

    // Add profile picture if uploaded
    if (req.file) {
      const resizedImage = await sharp(req.file.buffer)
        .resize(200, 200, { fit: 'cover' })
        .toBuffer();
      userData.profilePicture = {
        data: resizedImage,
        contentType: req.file.mimetype
      };
    }

    // Create and save user
    const user = new User(userData);
    await user.save();
    
    res.render("registration-success");
  } catch (error) {
    console.error('Registration error:', error);
    res.render("register", { 
      error: error.code === 11000 ? "Username or email already exists" : "Registration failed" 
    });
  }
});

const caseRoutes = require('./routes/case.routes');
app.use('/', caseRoutes);

app.get("/judiciary/dashboard", roleCheck(['judiciary']), async (req, res) => {
  if (req.session.userId && req.session.userRole === 'judiciary') {
    try {
      const user = await User.findById(req.session.userId);
      
      let query = {};
      if (user.jurisdictionLevel === 'district') {
        query = { 'jurisdiction.district': user.jurisdiction.district };
      } else if (user.jurisdictionLevel === 'state') {
        query = { 'jurisdiction.state': user.jurisdiction.state };
      }

      const totalCases = await Case.countDocuments(query);
      const activeCases = await Case.countDocuments({ ...query, status: { $ne: 'closed' } });
      const closedCases = await Case.countDocuments({ ...query, status: 'closed' });

      const casesByStatus = await Case.aggregate([
        { $match: query },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);

      const casesByPriority = await Case.aggregate([
        { $match: query },
        { $group: { _id: '$priority', count: { $sum: 1 } } }
      ]);

      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      
      const casesTimeline = await Case.aggregate([
        { $match: { ...query, createdAt: { $gte: sixMonthsAgo } } },
        { $group: {
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
        status: {
          labels: casesByStatus.map(s => s._id || 'New'),
          data: casesByStatus.map(s => s.count)
        },
        priority: {
          labels: casesByPriority.map(p => p._id || 'Unspecified'),
          data: casesByPriority.map(p => p.count)
        },
        timeline: {
          labels: casesTimeline.map(t => `${t._id.month}/${t._id.year}`),
          data: casesTimeline.map(t => t.count)
        }
      };

      res.render("judiciary/dashboard", {
        user,
        stats: { totalCases, activeCases, closedCases },
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

app.get("/judiciary/cases", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'judiciary') {
    try {
      const user = await User.findById(req.session.userId);
      
      let query = {};
      if (user.jurisdictionLevel === 'district') {
        query = { 'jurisdiction.district': user.jurisdiction.district };
      } else if (user.jurisdictionLevel === 'state') {
        query = { 'jurisdiction.state': user.jurisdiction.state };
      }

      const cases = await Case.find(query).sort({ createdAt: -1 });
      res.render("judiciary/cases", { cases });
    } catch (error) {
      console.error(error);
      res.status(500).send("Error fetching cases");
    }
  } else {
    res.redirect('/login');
  }
});

app.get("/judiciary/cases/:id", async (req, res) => {
  if (req.session.userId && req.session.userRole === 'judiciary') {
    try {
      const user = await User.findById(req.session.userId);
      const case_ = await Case.findById(req.params.id);

      if (!case_) {
        return res.status(404).send("Case not found");
      }

      if (user.jurisdictionLevel === 'district' && 
          case_.jurisdiction.district !== user.jurisdiction.district) {
        return res.status(403).send("Access denied");
      }
      if (user.jurisdictionLevel === 'state' && 
          case_.jurisdiction.state !== user.jurisdiction.state) {
        return res.status(403).send("Access denied");
      }

      res.render("judiciary/case-details", { case_ });
    } catch (error) {
      console.error(error);
      res.status(500).send("Error fetching case details");
    }
  } else {
    res.redirect('/login');
  }
});

// Import blockchain service
const { createPolicyOnBlockchain } = require('./routes/admin.policy.routes');

// Add policy management routes for admin
app.get("/admin/policies", isAdmin, async (req, res) => {
  try {
    const policies = await Policy.find({})
      .populate('createdBy', 'userName')
      .sort({ createdAt: -1 });
    res.render("admin/policies", { policies, error: null });
  } catch (error) {
    console.error(error);
    res.status(500).send("Error fetching policies");
  }
});

app.post("/admin/policies/add", isAdmin, async (req, res) => {
  try {
    const { name, description, categories, rules } = req.body;
    const policyId = 'policy-' + Date.now();

    // Create policy in MongoDB
    const policy = new Policy({
      policyId,
      name,
      description,
      categories: JSON.parse(categories),
      rules: JSON.parse(rules),
      createdBy: req.session.userId
    });

    await policy.save();
    
    // Create policy on blockchain
    try {
      await createPolicyOnBlockchain(
        policyId,
        categories, // Already in JSON string format
        rules,     // Already in JSON string format
        req.session.orgMspId
      );
    } catch (blockchainError) {
      // If blockchain fails, delete from MongoDB and throw error
      await Policy.findByIdAndDelete(policy._id);
      throw new Error(`Blockchain Error: ${blockchainError.message}`);
    }

    res.redirect('/admin/policies');
  } catch (error) {
    console.error('Policy creation error:', error);
    const policies = await Policy.find({});
    res.render("admin/policies", {
      error: "Error creating policy: " + error.message,
      policies
    });
  }
});

// Update the investigator case routes to include policy
app.get("/investigator/cases/new", roleCheck(['investigator']), async (req, res) => {
  try {
    const policies = await Policy.find({}).sort({ name: 1 });
    res.render("investigator/create-case", { 
      error: null,
      policies: policies
    });
  } catch (error) {
    console.error(error);
    res.render("investigator/create-case", { 
      error: "Error loading policies",
      policies: []
    });
  }
});

app.listen(3001, function() {
  console.log("Server started on port 3001");
});