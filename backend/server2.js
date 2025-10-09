require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mongoose = require('mongoose');
const Task = require('./models/Task'); // модель Task з кроками

// 🔗 Підключення до MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

const app = express();
app.use(bodyParser.json());
app.use(cors({ origin: 'http://localhost:5173' }));

// 🧮 Запуск задачі
app.post('/solve', async (req, res) => {
  const { number } = req.body;
  const serverName = "Сервер 2"; // змінюється на Сервер 2 для другого сервера

  // Створюємо нову задачу в БД з полем server
  const task = new Task({ number, server: serverName });
  await task.save();

  const taskId = task._id.toString();

  console.log(`🚀 Почато обчислення факторіалу ${number} (Task ID: ${taskId})`);

  let i = 1;
  const interval = setInterval(async () => {
    task.result *= i;
    task.steps.push({
      server: serverName,
      step: `${i} * ${number}`,
      result: task.result
    });

    task.progress = (i / number) * 100;
    await task.save();

    console.log(`⚙️  Крок ${i}: результат = ${task.result}, прогрес = ${task.progress.toFixed(1)}%`);

    i++;
    if (i > number) {
      task.progress = 100;
      await task.save();
      clearInterval(interval);
      console.log(`✅ Завершено обчислення факторіалу ${number}. Результат: ${task.result}`);
    }
  }, 500);

  res.json({ taskId });
});

// 📊 Отримання прогресу
app.get('/progress', async (req, res) => {
  const { taskId } = req.query;
  const task = await Task.findById(taskId);

  if (!task) {
    console.warn(`⚠️  Task ${taskId} не знайдено`);
    return res.json({ progress: 0, result: null, steps: [] });
  }

  res.json({
    progress: task.progress,
    result: task.result,
    steps: task.steps
  });
});

// 📊 Історія задач
app.get('/history', async (req, res) => {
  try {
    // Повертаємо останні 20 задач цього сервера
    const tasks = await Task.find({ server: "Сервер 2" })
                            .sort({ createdAt: -1 })
                            .limit(20);
    res.json(tasks);
  } catch (err) {
    console.error('❌ Помилка при отриманні історії:', err);
    res.status(500).json({ error: 'Помилка при отриманні історії' });
  }
});

app.listen(8002, () => console.log('🌐 Backend running on http://localhost:8002'));
