require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const Task = require('./models/Task');

// Підключення до MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected (Server 2)'))
  .catch(err => console.error(' MongoDB connection error:', err));

const app = express();
app.use(bodyParser.json());

// --- Змінні для управління задачами ---
const runningTasks = {}; // активні таймери задач
const taskQueue = [];   
let runningCount = 0;
const MAX_CONCURRENT_TASKS = 2;

async function runTask(taskData) {
  const { taskId, number } = taskData;
  const serverName = "Сервер 2";

  // Використовуємо BigInt для результату
  const task = new Task({ 
    taskId, 
    number, 
    server: serverName, 
    result: "1", // зберігаємо як рядок
    progress: 0, 
    steps: [] 
  });
  await task.save();

  return new Promise(resolve => {
    let current = 1n; // BigInt
    const bigNumber = BigInt(number);

    const interval = setInterval(async () => {
      // Множимо на BigInt
      const prevResult = BigInt(task.result);
      const newResult = prevResult * current;

      task.result = newResult.toString(); // зберігаємо як рядок
      task.steps.push({ server: serverName, step: `${current}! множення`, result: task.result });
      task.progress = Number(current * 100n / bigNumber);

      await task.save();

      if (current >= bigNumber) {
        task.progress = 100;
        await task.save();
        clearInterval(runningTasks[taskId]);
        delete runningTasks[taskId];
        runningCount--;
        processQueue(); // запускаємо наступні задачі з черги
        resolve();
      }

      current++;
    }, 500);

    runningTasks[taskId] = interval;
  });
}


// --- Обробка черги задач ---
function processQueue() {
  while (runningCount < MAX_CONCURRENT_TASKS && taskQueue.length > 0) {
    const nextTask = taskQueue.shift();
    runningCount++;
    runTask(nextTask).catch(err => {
      console.error(' Помилка при виконанні задачі:', err);
      runningCount--;
      processQueue();
    });
  }
}

// --- Endpoint запуску задачі ---
app.post('/solve', async (req, res) => {
  const { number, taskId } = req.body;

  if (number < 0 || isNaN(number)) return res.status(400).json({ error: 'Невірне число' });

  const taskData = { taskId, number };

  if (runningCount < MAX_CONCURRENT_TASKS) {
    runningCount++;
    runTask(taskData);
    res.json({ status: 'started', taskId });
  } else {
    taskQueue.push(taskData);
    res.json({ status: 'queued', taskId, position: taskQueue.length });
  }
});

// --- Endpoint для прогресу задачі ---
app.get('/progress', async (req, res) => {
  const { taskId } = req.query;
  const task = await Task.findOne({ taskId });
  if (!task) return res.status(404).json({ error: 'Задача не знайдена' });
  res.json({ progress: task.progress, result: task.result, steps: task.steps });
});

// --- Endpoint для історії задач ---
app.get('/history', async (req, res) => {
  const tasks = await Task.find({ server: "Сервер 2" }).sort({ createdAt: -1 }).limit(20);
  res.json(tasks);
});

// --- Endpoint скасування задачі ---
app.post('/cancel', async (req, res) => {
  const { taskId } = req.body;

  // Якщо задача виконується
  if (runningTasks[taskId]) {
    clearInterval(runningTasks[taskId]);
    delete runningTasks[taskId];
    runningCount--;
    processQueue();
  }

  // Якщо задача у черзі
  const queueIndex = taskQueue.findIndex(t => t.taskId === taskId);
  if (queueIndex !== -1) {
    taskQueue.splice(queueIndex, 1);
    return res.json({ status: 'Задача видалена з черги' });
  }

  // Якщо задача вже збережена у MongoDB
  const task = await Task.findOne({ taskId });
  if (task) {
    task.progress = 0;
    task.steps.push({ server: task.server, step: ' Скасовано', result: null });
    await task.save();
    return res.json({ status: 'Задача скасована' });
  }

  res.status(404).json({ error: 'Задача не знайдена або вже завершена' });
});

// Запуск сервера 
app.listen(process.env.PORT, '0.0.0.0', () => console.log(`Server running on http://localhost:${process.env.PORT}`));
