const mongoose = require('mongoose');

const stepSchema = new mongoose.Schema({
  server: String,   // сервер, який робив цей крок
  step: String,     // опис кроку, наприклад "1 * 5"
  result: Number    // проміжний результат
});

const taskSchema = new mongoose.Schema({
  number: { type: Number, required: true }, // число для факторіалу
  progress: { type: Number, default: 0 },
  result: { type: Number, default: 1 },
  server: { type: String, required: true }, // сервер, який отримав задачу
  steps: [stepSchema],
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Task', taskSchema);
