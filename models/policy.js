const mongoose = require('mongoose');

const PolicySchema = new mongoose.Schema({
  // This is the unique ID we send to Fabric (e.g., "policy-uuid-...")
  policyId: {
    type: String,
    required: true,
    unique: true
  },
  // This is the "friendly name" for the UI (e.g., "Investigator + Forensics")
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  // We will store the JSON for categories
  categories: {
    type: Object, // Mongoose stores JSON objects
    required: true
  },
  // We will store the JSON for rules
  rules: {
    type: Object,
    required: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Policy', PolicySchema);