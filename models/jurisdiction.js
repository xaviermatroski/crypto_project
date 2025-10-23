const mongoose = require('mongoose');

const JurisdictionSchema = new mongoose.Schema({
  state: {
    type: String,
    required: true
  },
  district: {
    type: String,
    required: true
  },
  policeStation: {
    type: String,
    required: true
  }
}, { 
  timestamps: true,
  unique: true 
});

module.exports = mongoose.model('Jurisdiction', JurisdictionSchema);
