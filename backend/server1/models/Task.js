const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  taskId: String,
  number: Number,
  server: String,
  result: String,
  progress: Number,
  steps: [{ 
    server: String, 
    step: String, 
    result: String 
  }],
  
  type: { 
    type: String, 
    enum: ['single', 'part', 'distributed'],
    default: 'single' 
  },
  
  partRange: String,
  parentTaskId: String,
  
  distributedParts: [{ 
    partId: String,
    start: Number,
    end: Number,
    server: String,
    result: String,
    progress: Number
  }],
  
  coordinatorUrl: String, 
  status: String,

  userId: {
    type: String,
    index: true
  },
  
  username: {
    type: String
  },
  
}, { timestamps: true });

taskSchema.index({ taskId: 1 });
taskSchema.index({ type: 1 });

module.exports = mongoose.model('Task', taskSchema);