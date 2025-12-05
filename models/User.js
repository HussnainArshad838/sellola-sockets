const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  role: {
    type: String,
    enum: ['admin', 'sub_admin', 'shop_owner', 'buyer', 'b2b_buyer'],
    default: 'buyer'
  },
  permissions: {
    shop: {
      approve: { type: Boolean, default: false },
      view: { type: Boolean, default: false }
    },
    b2b: {
      approve: { type: Boolean, default: false },
      view: { type: Boolean, default: false }
    },
    product: {
      approve: { type: Boolean, default: false },
      view: { type: Boolean, default: false }
    },
    user: {
      manage: { type: Boolean, default: false }
    }
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  status: {
    type: String,
    enum: ['active', 'pending', 'blocked'],
    default: 'active'
  },
  profile: {
    firstName: String,
    lastName: String,
    phone: String,
    address: {
      street: String,
      city: String,
      state: String,
      zipCode: String,
      country: String
    }
  },
  b2bRequest: {
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending'
    },
    categories: [{
      type: String,
      trim: true
    }],
    rejectionReason: String,
    requestedAt: {
      type: Date,
      default: Date.now
    },
    reviewedAt: Date,
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update the updatedAt field before saving
userSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('User', userSchema);

