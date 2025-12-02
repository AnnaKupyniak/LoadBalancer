const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  taskId: String,
  number: Number,
  server: String,
  result: Number,
  progress: Number,
  steps: [{ server: String, step: String, result: Number }],
}, { timestamps: true });

module.exports = mongoose.model('Task', taskSchema);
