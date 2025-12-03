require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const axios = require('axios');
const Task = require('./models/Task');

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected (Server 1)'))
  .catch(err => console.error('MongoDB connection error:', err));

const app = express();
app.use(bodyParser.json());

const runningTasks = {};
const taskQueue = [];
let runningCount = 0;
const MAX_CONCURRENT_TASKS = 2;

const DISTRIBUTION_THRESHOLD = 70; 

async function runTask(taskData) {
  const { taskId, number } = taskData;
  const serverName = "Сервер 1";

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
  const serverName = "Сервер 1";

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

async function distributeLargeTask(number, mainTaskId) {
  const mainTask = new Task({
    taskId: mainTaskId,
    number,
    server: "Розподілено на 2 сервери",
    result: "обчислюється...",
    progress: 0,
    steps: [],
    type: 'distributed',
    distributedParts: []
  });
  await mainTask.save();
  
  // Розбиваємо на дві рівні частини
  const mid = Math.floor(number / 2);
  
  const parts = [
    { start: 1, end: mid, server: 'server1' },      
    { start: mid + 1, end: number, server: 'server2' } // Друга половина на сервері 2
  ];
  
  // Запускаємо частини
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const partTaskId = `${mainTaskId}_part${i + 1}`;

    mainTask.distributedParts.push({
      partId: partTaskId,
      start: part.start,
      end: part.end,
      server: part.server,
      progress: 0,
      result: "1"
    });
    
    if (part.server === 'server1') {
      const taskData = {
        taskId: partTaskId,
        start: part.start,
        end: part.end,
        initialValue: "1"
      };
      
      if (runningCount < MAX_CONCURRENT_TASKS) {
        runningCount++;
        runTaskPart(taskData);
      } else {
        taskQueue.push(taskData);
      }
    } else {
      // Відправляємо на сервер 2
      try {
        await axios.post('http://backend2:8002/solve-part', {
          taskId: partTaskId,
          start: part.start,
          end: part.end,
          initialValue: "1"
        });
        console.log(`Частина ${i + 1} (${part.start}-${part.end}) відправлена на сервер 2`);
      } catch (err) {
        console.error(`Помилка відправки на сервер 2: ${err.message}`);
        // Якщо сервер 2 недоступний - запускаємо тут
        const taskData = {
          taskId: partTaskId,
          start: part.start,
          end: part.end,
          initialValue: "1"
        };
        
        if (runningCount < MAX_CONCURRENT_TASKS) {
          runningCount++;
          runTaskPart(taskData);
        } else {
          taskQueue.push(taskData);
        }
      }
    }
  }
  
  await mainTask.save();
  
  return {
    status: 'distributed',
    taskId: mainTaskId,
    parts: 2,
    message: `Задача розподілена на 2 сервери`
  };
}
function processQueue() {
  while (runningCount < MAX_CONCURRENT_TASKS && taskQueue.length > 0) {
    const nextTask = taskQueue.shift();
    runningCount++;
    
    if (nextTask.start && nextTask.end) {
      runTaskPart(nextTask).catch(err => {
        console.error('Помилка виконання частини:', err);
        runningCount--;
        processQueue();
      });
    } else {
      runTask(nextTask).catch(err => {
        console.error('Помилка виконання задачі:', err);
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

  if (number <= DISTRIBUTION_THRESHOLD) {
    const taskData = { taskId, number };

    if (runningCount < MAX_CONCURRENT_TASKS) {
      runningCount++;
      runTask(taskData);
      res.json({ 
        success: true,
        status: 'started', 
        taskId,
        type: 'single',
        server: 'server1',
        message: `Задача ${number}! запущена на одному сервері`
      });
    } else {
      taskQueue.push(taskData);
      res.json({ 
        success: true,
        status: 'queued', 
        taskId, 
        position: taskQueue.length,
        type: 'single',
        message: `Задача ${number}! додана в чергу (позиція: ${taskQueue.length})`
      });
    }
  } else {
    return res.status(400).json({ 
      error: `Для числа ${number} використовуйте /solve-distributed`,
      message: 'Для чисел 71-170 потрібен спеціальний endpoint',
      code: 'USE_DISTRIBUTED_ENDPOINT',
      correctEndpoint: '/solve-distributed'
    });
  }
});

app.post('/solve-distributed', async (req, res) => {
  const { number, taskId } = req.body;

  if (number <= DISTRIBUTION_THRESHOLD) {
    return res.status(400).json({ 
      error: 'Цей endpoint тільки для чисел 71-170',
      message: `Число ${number} замале для розподілу`,
      suggestion: 'Використовуйте /solve для чисел 0-70',
      code: 'USE_REGULAR_ENDPOINT'
    });
  }
  
  if (number > 170) {
    return res.status(400).json({ 
      error: 'Число не може бути більше 170',
      code: 'NUMBER_TOO_LARGE'
    });
  }
  
  try {
    const result = await distributeLargeTask(number, taskId);
    res.json({
      success: true,
      status: 'distributed',
      taskId,
      type: 'distributed',
      parts: result.parts || 2,
      message: result.message || `Задача ${number}! розподілена на 2 сервери`,
      server: 'server1 (координатор)',
      note: 'Задача розподілена на дві частини між серверами'
    });
  } catch (err) {
    console.error('Помилка розподілу:', err);
    res.status(500).json({ 
      success: false,
      error: 'Помилка розподілу задачі',
      details: err.message,
      code: 'DISTRIBUTION_ERROR'
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
      message: `Частина задачі ${start}-${end} запущена`
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

  const mainTask = await Task.findOne({ taskId });
  
  if (!mainTask) {
    const partTask = await Task.findOne({ taskId });
    if (partTask) {
      return res.json({
        success: true,
        progress: partTask.progress,
        result: partTask.result,
        steps: partTask.steps,
        type: 'part',
        range: partTask.partRange,
        server: partTask.server
      });
    }
    return res.status(404).json({ 
      success: false,
      error: 'Задача не знайдена',
      code: 'TASK_NOT_FOUND'
    });
  }
  
  if (mainTask.type === 'distributed') {
    // Для розподіленої задачі - збираємо прогрес частин
    const partIds = mainTask.distributedParts?.map(p => p.partId) || [];
    const partTasks = await Task.find({ taskId: { $in: partIds } });
    
    // Оновлюємо прогрес у головній задачі
    let totalProgress = 0;
    let allCompleted = true;
    let partProgress = [];
    
    partTasks.forEach(part => {
      const partInfo = mainTask.distributedParts?.find(p => p.partId === part.taskId);
      if (partInfo) {
        partInfo.progress = part.progress;
        partInfo.result = part.result;
        totalProgress += part.progress;
        
        if (part.progress < 100) allCompleted = false;
        
        partProgress.push({
          partId: part.taskId,
          start: partInfo.start,
          end: partInfo.end,
          range: `${partInfo.start}-${partInfo.end}`,
          server: partInfo.server,
          progress: part.progress
        });
      }
    });
    
    mainTask.progress = partTasks.length > 0 ? totalProgress / partTasks.length : 0;
    
    if (allCompleted && partTasks.length > 0) {
      try {
        let finalResult = 1n;
        for (const part of partTasks) {
          finalResult *= BigInt(part.result);
        }
        mainTask.result = finalResult.toString();
        mainTask.progress = 100;
      } catch (err) {
        console.error('Помилка обчислення фінального результату:', err);
      }
    }
    
    await mainTask.save();
    
    res.json({
      success: true,
      progress: mainTask.progress,
      result: mainTask.result,
      steps: mainTask.steps,
      type: 'distributed',
      parts: mainTask.distributedParts?.length || 0,
      partProgress: partProgress,
      message: allCompleted ? 'Усі частини завершені' : 'Виконується...'
    });
  } else {
    res.json({
      success: true,
      progress: mainTask.progress,
      result: mainTask.result,
      steps: mainTask.steps.slice(-5),
      type: 'single',
      server: mainTask.server
    });
  }
});

app.get('/history', async (req, res) => {
  try {
    const tasks = await Task.find({ 
      $or: [
        { type: { $ne: 'part' } },
        { type: { $exists: false } }
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
    
    if (task.type === 'distributed' && task.distributedParts) {
      for (const part of task.distributedParts) {
        await Task.findOneAndUpdate(
          { taskId: part.partId },
          { 
            progress: 0,
            $push: { steps: { server: 'System', step: 'Cancelled', result: null } }
          }
        );
      }
    }
    
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
  console.log(` Сервер 1 (Координатор) запущено на http://0.0.0.0:${process.env.PORT}`);
});