const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const AddressSchema = new mongoose.Schema({
  street: String,
  city: String,
  state: String,
  zipCode: String,
  country: { type: String, default: "India" }
});

const UserSchema = new mongoose.Schema({
  profilePicture: {
    data: Buffer,
    contentType: String
  },
  userName: { 
    type: String, 
    required: true,
    unique: true,
    minlength: 3,
    maxlength: 30,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Invalid email']
  },
  password: {
    type: String,
    required: true,
    select: false
  },
  phone: {
    type: String,
    required: true,
    unique: false,
    match: [/^[0-9]{10}$/, 'Invalid phone number']
  },
  
  address: AddressSchema,
  registrationDate: {
    type: Date,
    default: Date.now
  },
  role: {
    type: String,
    enum: ['investigator', 'admin', 'forensics_officer', 'judiciary'],
    default: 'user'
  },
  jurisdictionLevel: {
    type: String,
    enum: ['district', 'state', 'national', null],
    default: null
  },
  isBlocked: {
    type: Boolean,
    default: false
  },
  blockedAt: {
    type: Date,
    default: null
  },
  blockedReason: {
    type: String,
    default: null
  },
  lastSeen: {
    type: Date,
    default: Date.now
  },
  authCookie: {
    type: String,
    default: null
  },
  authCookieCreated: {
    type: Date,
    default: null
  },
  authCookieExpires: {
    type: Date,
    default: null
  },
  resetPasswordOTP: String,
  resetPasswordExpires: Date,
  isApproved: {
    type: Boolean,
    default: false
  },
  approvedAt: {
    type: Date
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  jurisdiction: {
    district: String,
    state: String
  }
}, { timestamps: true });

// Hash password before saving
UserSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

UserSchema.methods.isUserBlocked = function() {
  return this.isBlocked === true;
};

UserSchema.methods.getBlockedMessage = function() {
  return `Your account has been deactivated. Reason: ${this.blockedReason || 'No reason provided'}`;
};

module.exports = mongoose.model('User', UserSchema);