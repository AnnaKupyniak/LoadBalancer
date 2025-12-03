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
  
  // Для розподілених задач
  type: { 
    type: String, 
    enum: ['single', 'part', 'distributed'],
    default: 'single' 
  },
  
  // Для частин задач
  partRange: String, // наприклад: "1-50"
  parentTaskId: String, // ID головної задачі (для частин)
  
  // Для розподілених задач
  distributedParts: [{ 
    partId: String,
    start: Number,
    end: Number,
    server: String
  }]
  
}, { timestamps: true });

// Прості індекси
taskSchema.index({ taskId: 1 });
taskSchema.index({ type: 1 });

module.exports = mongoose.model('Task', taskSchema);