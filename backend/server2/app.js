require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const axios = require('axios');
const Task = require('./models/Task');

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected (Server 2)'))
  .catch(err => console.error(' MongoDB connection error:', err));

const app = express();
app.use(bodyParser.json());

const runningTasks = {}; 
const taskQueue = [];   
let runningCount = 0;
const MAX_CONCURRENT_TASKS = 2;

const DISTRIBUTION_THRESHOLD = 70; 

async function runTask(taskData) {
  const { taskId, number } = taskData;
  const serverName = "Сервер 2";

  const task = new Task({ 
    taskId, 
    number, 
    server: serverName, 
    result: "1",
    progress: 0, 
    steps: [],
    type: 'single'
  });
  await task.save();

  return new Promise(resolve => {
    let current = 1n;
    const bigNumber = BigInt(number);

    const interval = setInterval(async () => {
      const prevResult = BigInt(task.result);
      const newResult = prevResult * current;

      task.result = newResult.toString();
      task.steps.push({ 
        server: serverName, 
        step: `${current}!`, 
        result: task.result 
      });
      task.progress = Number(current * 100n / bigNumber);

      await task.save();

      if (current >= bigNumber) {
        task.progress = 100;
        await task.save();
        clearInterval(runningTasks[taskId]);
        delete runningTasks[taskId];
        runningCount--;
        processQueue();
        resolve();
      }

      current++;
    }, 500);

    runningTasks[taskId] = interval;
  });
}

async function runTaskPart(taskData) {
  const { taskId, start, end, initialValue = "1" } = taskData;
  const serverName = "Сервер 2";

  const task = new Task({ 
    taskId, 
    number: end, 
    server: serverName, 
    result: initialValue,
    progress: 0, 
    steps: [],
    type: 'part',
    partRange: `${start}-${end}`
  });
  await task.save();

  return new Promise(resolve => {
    let current = BigInt(start);
    const bigEnd = BigInt(end);
    const totalSteps = Number(bigEnd - BigInt(start) + 1n);
    let completedSteps = 0;

    const interval = setInterval(async () => {
      const prevResult = BigInt(task.result);
      const newResult = prevResult * current;

      task.result = newResult.toString();
      task.steps.push({ 
        server: serverName, 
        step: `${current}! (частина)`, 
        result: task.result 
      });
      task.progress = Math.min(100, (completedSteps / totalSteps) * 100);

      await task.save();

      if (current >= bigEnd) {
        task.progress = 100;
        await task.save();
        clearInterval(runningTasks[taskId]);
        delete runningTasks[taskId];
        runningCount--;
        processQueue();
        resolve();
      }

      current++;
      completedSteps++;
    }, 500);

    runningTasks[taskId] = interval;
  });
}
function processQueue() {
  while (runningCount < MAX_CONCURRENT_TASKS && taskQueue.length > 0) {
    const nextTask = taskQueue.shift();
    runningCount++;
    
    if (nextTask.start && nextTask.end) {
      runTaskPart(nextTask).catch(err => {
        console.error(' Помилка виконання частини:', err);
        runningCount--;
        processQueue();
      });
    } else {
      runTask(nextTask).catch(err => {
        console.error(' Помилка виконання задачі:', err);
        runningCount--;
        processQueue();
      });
    }
  }
}

app.post('/solve', async (req, res) => {
  const { number, taskId } = req.body;

  if (number < 0 || isNaN(number) || number > 170) {
    return res.status(400).json({ 
      error: 'Число має бути від 0 до 170',
      code: 'INVALID_NUMBER'
    });
  }

  if (number > DISTRIBUTION_THRESHOLD) {
    return res.status(400).json({ 
      error: 'Для чисел 71-170 використовуйте /api/solve-distributed',
      message: `Число ${number} завелике для цього сервера`,
      suggestion: 'Використовуйте ендпоінт для розподілених задач',
      code: 'USE_DISTRIBUTED_ENDPOINT',
      correctEndpoint: '/api/solve-distributed'
    });
  }

  const taskData = { taskId, number };

  if (runningCount < MAX_CONCURRENT_TASKS) {
    runningCount++;
    runTask(taskData);
    res.json({ 
      success: true,
      status: 'started', 
      taskId,
      type: 'single',
      server: 'server2',
      message: `Задача ${number}! запущена на сервері 2`
    });
  } else {
    taskQueue.push(taskData);
    res.json({ 
      success: true,
      status: 'queued', 
      taskId, 
      position: taskQueue.length,
      type: 'single',
      message: `Задача ${number}! додана в чергу сервера 2`
    });
  }
});

app.post('/solve-part', async (req, res) => {
  const { taskId, start, end, initialValue = "1" } = req.body;

  if (!start || !end || start > end) {
    return res.status(400).json({ 
      error: 'Невірний діапазон',
      details: `start: ${start}, end: ${end}`
    });
  }

  const taskData = { 
    taskId, 
    start: parseInt(start), 
    end: parseInt(end), 
    initialValue
  };

  if (runningCount < MAX_CONCURRENT_TASKS) {
    runningCount++;
    runTaskPart(taskData);
    res.json({ 
      success: true,
      status: 'started', 
      taskId,
      type: 'part',
      range: `${start}-${end}`,
      server: 'server2',
      message: `Частина задачі ${start}-${end} запущена на сервері 2`
    });
  } else {
    taskQueue.push(taskData);
    res.json({ 
      success: true,
      status: 'queued', 
      taskId, 
      position: taskQueue.length,
      type: 'part',
      message: `Частина задачі ${start}-${end} додана в чергу`
    });
  }
});

app.get('/progress', async (req, res) => {
  const { taskId } = req.query;
  
  if (!taskId) {
    return res.status(400).json({ 
      error: 'Відсутній taskId',
      code: 'MISSING_TASK_ID'
    });
  }
  
  const task = await Task.findOne({ taskId });
  
  if (!task) {
    return res.status(404).json({ 
      success: false,
      error: 'Задача не знайдена',
      code: 'TASK_NOT_FOUND'
    });
  }
  
  if (task.type === 'part') {
    return res.json({
      success: true,
      progress: task.progress,
      result: task.result,
      steps: task.steps,
      type: 'part',
      range: task.partRange,
      server: task.server
    });
  } else {
    return res.json({
      success: true,
      progress: task.progress,
      result: task.result,
      steps: task.steps,
      type: 'single',
      server: task.server
    });
  }
});

app.get('/history', async (req, res) => {
  try {
    const tasks = await Task.find({ 
      $or: [
        { server: "Сервер 2" },
        { type: 'part' }
      ]
    })
    .sort({ createdAt: -1 })
    .limit(20);
    
    res.json({
      success: true,
      count: tasks.length,
      tasks: tasks
    });
  } catch (err) {
    console.error('Помилка отримання історії:', err);
    res.status(500).json({
      success: false,
      error: 'Помилка отримання історії',
      details: err.message
    });
  }
});

app.post('/cancel', async (req, res) => {
  const { taskId } = req.body;

  if (!taskId) {
    return res.status(400).json({ 
      error: 'Відсутній taskId',
      code: 'MISSING_TASK_ID'
    });
  }

  if (runningTasks[taskId]) {
    clearInterval(runningTasks[taskId]);
    delete runningTasks[taskId];
    runningCount--;
    processQueue();
  }

  const queueIndex = taskQueue.findIndex(t => t.taskId === taskId);
  if (queueIndex !== -1) {
    taskQueue.splice(queueIndex, 1);
    return res.json({ 
      success: true,
      status: 'Задача видалена з черги',
      taskId
    });
  }

  const task = await Task.findOne({ taskId });
  if (task) {
    task.progress = 0;
    task.steps.push({ 
      server: task.server, 
      step: 'Скасовано', 
      result: null 
    });
    await task.save();
    
    return res.json({ 
      success: true,
      status: 'Задача скасована',
      taskId,
      type: task.type
    });
  }

  res.status(404).json({ 
    success: false,
    error: 'Задача не знайдена',
    code: 'TASK_NOT_FOUND'
  });
});

app.listen(process.env.PORT, '0.0.0.0', () => {
  console.log(`Сервер 2 (Робочий) запущено на http://0.0.0.0:${process.env.PORT}`);
});