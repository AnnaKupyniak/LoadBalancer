require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const axios = require('axios');
const redis = require('redis');
const Task = require('./models/Task');
const { Worker } = require('worker_threads');
const path = require('path');
const crypto = require('crypto');
const authMiddleware = require('./middleware/auth'); 
const uuidv4 = () => crypto.randomUUID();

// --- НАЛАШТУВАННЯ ---
const SERVER_ID = process.env.SERVER_ID || 'serverX';
const SERVER_PORT = process.env.PORT || 8001;
const PEER_URL = process.env.PEER_URL;
const BASE_URL = process.env.BASE_URL || `http://${SERVER_ID}:${SERVER_PORT}`;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DISTRIBUTION_THRESHOLD = 70;
const MAX_CONCURRENT_TASKS = parseInt(process.env.MAX_CONCURRENT_TASKS) || 2;
const GLOBAL_QUEUE_NAME = process.env.GLOBAL_QUEUE_NAME || 'factorial:global:queue';

// Redis клієнт
let redisClient;
let redisSubscriber;

async function initRedis() {
  redisClient = redis.createClient({ 
    url: REDIS_URL,
    socket: {
      reconnectStrategy: (retries) => {
        if (retries > 10) {
          console.log('Too many retries for Redis. Giving up.');
          return new Error('Too many retries');
        }
        return Math.min(retries * 100, 3000);
      }
    }
  });
  
  redisClient.on('error', (err) => console.error('Redis Client Error:', err));
  redisClient.on('connect', () => console.log(`Redis connected (${SERVER_ID})`));
  
  await redisClient.connect();
  
  console.log(`Redis connected (${SERVER_ID})`);
}

// Стан
let runningCount = 0;
const runningTasks = {};
const saveQueueProcessing = new Map();
let isQueueProcessing = false;

// DB
mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
  .then(() => console.log(`MongoDB connected (${SERVER_ID})`))
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

// Middleware для логування
app.use((req, res, next) => {
  console.log(`[${SERVER_ID}] 📨 ${req.method} ${req.url}`);
  if (req.body && req.body.coordinatorUrl) {
    console.log(`[${SERVER_ID}] 📍 coordinatorUrl у запиті: ${req.body.coordinatorUrl}`);
  }
  next();
});

initRedis().catch(err => {
  console.error('Failed to initialize Redis:', err);
});

// ------------------------------------------------------------------- 
// ДОПОМІЖНІ ФУНКЦІЇ
// -------------------------------------------------------------------

const processSaveQueue = async (taskId, task, saveQueue) => {
  if (saveQueueProcessing.get(taskId)) return;
  
  saveQueueProcessing.set(taskId, true);
  
  const updates = [...saveQueue];
  saveQueue.length = 0;
  
  for (const update of updates) {
    if (update.type === 'progress') {
      task.result = update.currentValue;
      task.progress = Math.min(100, update.progress);
      
      const stepData = update.stepData || {
        server: SERVER_ID,
        step: update.stepInfo,
        result: update.currentValue.substring(0, 50) + '...'
      };
      
      task.steps.push(stepData);
    } else if (update.type === 'done') {
      task.result = update.result;
      task.progress = 100;
      task.status = 'completed';
    } else if (update.type === 'error') {
      task.result = 'ERROR';
      task.progress = 0;
      task.status = 'failed';
      task.steps.push(update.stepData);
    }
    
    try {
      await task.save();
    } catch (dbErr) {
      console.error(`DB save error for ${taskId}:`, dbErr);
    }
  }
  
  saveQueueProcessing.set(taskId, false);

  if (saveQueue.length > 0) {
    processSaveQueue(taskId, task, saveQueue);
  }
};

async function startWorkerTask(workerParams, task) {
  const { taskId, serverName } = workerParams;
  const saveQueue = [];
  
  console.log(`[${SERVER_ID}] 🔥 ВХІД до startWorkerTask для ${taskId}`);
  console.log(`[${SERVER_ID}] 📊 Параметри воркера:`, {
    start: workerParams.start,
    end: workerParams.end,
    serverName: workerParams.serverName,
    isPart: workerParams.isPart
  });
  
  return new Promise((resolve, reject) => {
    try {
      console.log(`[${SERVER_ID}] 🔧 Створюю Worker для ${taskId}`);
      console.log(`[${SERVER_ID}] 📍 Шлях до worker.js: ${path.join(__dirname, 'worker.js')}`);
      
      // Перевіряємо, чи файл існує
      const fs = require('fs');
      const workerPath = path.join(__dirname, 'worker.js');
      if (!fs.existsSync(workerPath)) {
        console.error(`[${SERVER_ID}] ❌ Файл worker.js не знайдено: ${workerPath}`);
        throw new Error(`Файл worker.js не знайдено: ${workerPath}`);
      }
      
      const worker = new Worker(workerPath, {
        workerData: workerParams
      });
      
      console.log(`[${SERVER_ID}] ✅ Worker створено успішно для ${taskId}`);
      
      runningTasks[taskId] = worker;
      console.log(`[${SERVER_ID}] 📝 Додано ${taskId} до runningTasks, зараз: ${Object.keys(runningTasks).length} задач`);
      
      // 1. Обробка повідомлень від воркера
      worker.on('message', (msg) => {
        console.log(`[${SERVER_ID}] 📨 ОТРИМАНО ПОВІДОМЛЕННЯ від ${taskId}:`, {
          type: msg.type,
          progress: msg.progress,
          stepInfo: msg.stepInfo ? msg.stepInfo.substring(0, 50) + '...' : 'немає',
          timestamp: new Date().toISOString()
        });
        
        if (msg.type === 'progress') {
          console.log(`[${SERVER_ID}] 📊 ПРОГРЕС ${taskId}: ${msg.progress}% - "${msg.stepInfo}"`);
          
          const stepData = {
            server: serverName,
            step: msg.stepInfo,
            result: msg.currentValue && msg.currentValue.length > 50 
              ? msg.currentValue.substring(0, 50) + '...' 
              : msg.currentValue || 'немає'
          };
          
          saveQueue.push({ 
            type: 'progress', 
            ...msg, 
            stepData,
            receivedAt: Date.now()
          });
          
          console.log(`[${SERVER_ID}] 💾 Додано до saveQueue для ${taskId}, розмір: ${saveQueue.length}`);
          processSaveQueue(taskId, task, saveQueue);
          
        } else if (msg.type === 'done') {
          console.log(`[${SERVER_ID}] 🎉 ВОРКЕР ${taskId} ЗАВЕРШИВСЯ! Результат: ${msg.result ? msg.result.substring(0, 30) + '...' : 'немає'}`);
          
          saveQueue.push({ 
            type: 'done', 
            ...msg,
            receivedAt: Date.now()
          });
          
          processSaveQueue(taskId, task, saveQueue).then(async () => {
            // Обробка частини задачі
            if (task.type === 'part' && task.parentTaskId) {
              try {
                const actualCoordinatorUrl = task.coordinatorUrl;
                
                if (!actualCoordinatorUrl) {
                  console.error(`[${SERVER_ID}] ❌ Не знайдено coordinatorUrl для ${taskId}`);
                  
                  let fallbackUrl;
                  if (SERVER_ID === 'server2') {
                    fallbackUrl = PEER_URL;
                  } else {
                    fallbackUrl = BASE_URL;
                  }
                  
                  console.log(`[${SERVER_ID}] 📌 Використовую fallback: ${fallbackUrl}`);
                  
                  try {
                    const response = await axios.post(`${fallbackUrl}/part-completed`, {
                      partTaskId: taskId,
                      result: msg.result,
                      mainTaskId: task.parentTaskId
                    }, {
                      timeout: 5000
                    });
                    
                    console.log(`[${SERVER_ID}] ✅ Успішно повідомлено координатора (fallback):`, response.data);
                  } catch (fallbackErr) {
                    console.error(`[${SERVER_ID}] ❌ Fallback також не спрацював:`, fallbackErr.message);
                  }
                } else {
                  console.log(`[${SERVER_ID}] 📣 Повідомлення координатора: ${actualCoordinatorUrl}/part-completed`);
                  
                  const response = await axios.post(`${actualCoordinatorUrl}/part-completed`, {
                    partTaskId: taskId,
                    result: msg.result,
                    mainTaskId: task.parentTaskId
                  }, {
                    timeout: 5000
                  });
                  
                  console.log(`[${SERVER_ID}] ✅ Успішно повідомлено координатора:`, response.data);
                }
              } catch (notifyErr) {
                console.error(`[${SERVER_ID}] ❌ Помилка повідомлення координатора для ${taskId}:`, notifyErr.message);
              }
            }
            
            delete runningTasks[taskId];
            runningCount = Math.max(0, runningCount - 1);
            console.log(`[${SERVER_ID}] 🔚 Видалено ${taskId} з runningTasks, залишилось: ${Object.keys(runningTasks).length}`);
            console.log(`[${SERVER_ID}] 📉 runningCount: ${runningCount} (було ${runningCount + 1})`);
            
            resolve();
          }).catch(err => {
            console.error(`[${SERVER_ID}] ❌ Помилка збереження результату для ${taskId}:`, err);
            delete runningTasks[taskId];
            runningCount = Math.max(0, runningCount - 1);
            reject(err);
          });
          
        } else if (msg.type === 'hello') {
          console.log(`[${SERVER_ID}] 👋 Воркер ${taskId} каже: ${msg.message}`);
        } else if (msg.type === 'error') {
          console.error(`[${SERVER_ID}] ❌ Воркер ${taskId} повідомив про помилку:`, msg.error);
        }
      });
      
      // 2. Обробка помилок воркера
      worker.on('error', (err) => {
        console.error(`[${SERVER_ID}] ❌ ПОМИЛКА ВОРКЕРА ${taskId}:`, err);
        console.error(`[${SERVER_ID}] ❌ Стек помилки:`, err.stack);
        
        saveQueue.push({
          type: 'error',
          stepData: { 
            server: 'System', 
            step: 'Worker Error', 
            result: err.message 
          },
          receivedAt: Date.now()
        });
        
        processSaveQueue(taskId, task, saveQueue).finally(() => {
          delete runningTasks[taskId];
          runningCount = Math.max(0, runningCount - 1);
          console.error(`[${SERVER_ID}] 🚨 Воркер ${taskId} завершився з помилкою`);
          reject(err);
        });
      });
      
      // 3. Обробка виходу воркера
      worker.on('exit', (code) => {
        console.log(`[${SERVER_ID}] 🔚 Воркер ${taskId} вийшов з кодом: ${code}`);
        
        if (code !== 0 && code !== 1 && runningTasks[taskId]) {
          console.error(`[${SERVER_ID}] ⚠️ Воркер ${taskId} зупинився неочікувано з кодом ${code}`);
          delete runningTasks[taskId];
          runningCount = Math.max(0, runningCount - 1);
        }
      });
      
      // 4. Відправляємо тестове повідомлення воркеру (опціонально)
      setTimeout(() => {
        if (worker.threadId) {
          console.log(`[${SERVER_ID}] 🧪 Воркер ${taskId} має threadId: ${worker.threadId}`);
        }
      }, 100);
      
    } catch (workerCreationError) {
      console.error(`[${SERVER_ID}] ❌ КРИТИЧНА ПОМИЛКА СТВОРЕННЯ ВОРКЕРА для ${taskId}:`, workerCreationError);
      console.error(`[${SERVER_ID}] ❌ Стек помилки:`, workerCreationError.stack);
      reject(workerCreationError);
    }
  });
}

async function runTask(taskData, userId, username) {
  const { taskId, number } = taskData;
  
  let task = await Task.findOne({ taskId });
  if (!task) {
    task = new Task({
      taskId,
      number,
      server: SERVER_ID,
      result: "1",
      progress: 0,
      steps: [],
      type: 'single',
      status: 'processing',
      userId: userId,
      username: username
    });
  } else {
    task.server = SERVER_ID;
    task.status = 'processing';
    task.userId = userId;
    task.username = username;
  }
  
  await task.save();
  
  const workerParams = {
    taskId: taskId,
    start: 1,
    end: number,
    initialValue: "1",
    serverName: SERVER_ID,
    isPart: false
  };
  
  return startWorkerTask(workerParams, task);
}

async function runTaskPart(partTaskData) {
  const { taskId, start, end, initialValue, parentTaskId, coordinatorUrl } = partTaskData;
  
  console.log(`[${SERVER_ID}] 🚀 Запуск частини ${taskId}: ${start}-${end}`);
  console.log(`[${SERVER_ID}] 📌 Отриманий coordinatorUrl: ${coordinatorUrl}`);
  console.log(`[${SERVER_ID}] 📌 Мій SERVER_ID: ${SERVER_ID}`);
  
  let actualCoordinatorUrl = coordinatorUrl;
  
  if (!actualCoordinatorUrl) {
    console.warn(`[${SERVER_ID}] ⚠️ Не отримано coordinatorUrl, використовую fallback`);
    if (SERVER_ID === 'server2') {
      actualCoordinatorUrl = PEER_URL;
    } else {
      actualCoordinatorUrl = BASE_URL;
    }
  }
  
  console.log(`[${SERVER_ID}] 📌 Буде використано coordinatorUrl: ${actualCoordinatorUrl}`);
  
  let task = await Task.findOne({ taskId });
  if (!task) {
    task = new Task({
      taskId,
      number: end,
      server: SERVER_ID,
      result: initialValue,
      progress: 0,
      steps: [{ 
        server: SERVER_ID, 
        step: `Частина запущена (${start}-${end})`, 
        result: null 
      }],
      type: 'part',
      parentTaskId: parentTaskId,
      coordinatorUrl: actualCoordinatorUrl,
      status: 'processing'
    });
  } else {
    task.server = SERVER_ID;
    task.status = 'processing';
    task.coordinatorUrl = actualCoordinatorUrl;
    task.steps.push({ 
      server: SERVER_ID, 
      step: `Частина взята з черги (${start}-${end})`, 
      result: null 
    });
  }

  await task.save();
  
  const workerParams = {
    taskId: taskId,
    start: start,
    end: end,
    initialValue: initialValue,
    serverName: SERVER_ID,
    isPart: true
  };
  
  return startWorkerTask(workerParams, task);
}

// -------------------------------------------------------------------
// РОЗПОДІЛ ЗАДАЧ ДЛЯ ВЕЛИКИХ ЧИСЕЛ
// -------------------------------------------------------------------

async function distributeLargeTask(number, mainTaskId, userId, username) {
  console.log(`[${SERVER_ID}] 🔀 Розподіл задачі ${number}! (ID: ${mainTaskId}) для користувача ${username}`);
  
  const task = new Task({
    taskId: mainTaskId,
    number: number,
    server: SERVER_ID,
    result: 'Distribution in progress',
    progress: 0,
    steps: [{ server: SERVER_ID, step: 'Ініціалізація розподілу', result: null }],
    type: 'distributed',
    distributedParts: [],
    status: 'coordinating',
    userId: userId,
    username: username
  });
  
  await task.save();
  
  const midpoint = Math.floor(number / 2);
  
  const myUrl = BASE_URL;
  
  console.log(`[${SERVER_ID}] Мій URL для координації: ${myUrl}`);
  
  const parts = [
    { 
      start: 1, 
      end: midpoint, 
      server: SERVER_ID, 
      partId: `${mainTaskId}_part1`,
      initialValue: "1",
      coordinatorUrl: myUrl
    },
    { 
      start: midpoint + 1, 
      end: number, 
      server: PEER_URL ? 'peer' : SERVER_ID,
      partId: `${mainTaskId}_part2`,
      initialValue: "1",
      coordinatorUrl: myUrl
    }
  ];
  
  for (const part of parts) {
    console.log(`[${SERVER_ID}] 🔄 Обробка частини ${part.partId}: ${part.start}-${part.end} на ${part.server}`);
    
    task.distributedParts.push({
      partId: part.partId,
      start: part.start,
      end: part.end,
      server: part.server,
      progress: 0
    });
  }
  
  await task.save();
  
  for (const part of parts) {
    const queueItem = {
      taskId: part.partId,
      start: part.start,
      end: part.end,
      initialValue: part.initialValue,
      parentTaskId: mainTaskId,
      coordinatorUrl: myUrl,
      type: 'part',
      timestamp: Date.now(),
      serverId: part.server === 'peer' && PEER_URL ? 'peer' : SERVER_ID,
      status: 'queued'
    };
    
    if (part.server === SERVER_ID || !PEER_URL) {
      if (runningCount < MAX_CONCURRENT_TASKS) {
        runningCount++;
        
        console.log(`[${SERVER_ID}] 🚀 Запуск частини ${part.partId} негайно`);
        
        runTaskPart({
          taskId: part.partId,
          start: part.start,
          end: part.end,
          initialValue: part.initialValue,
          parentTaskId: mainTaskId,
          coordinatorUrl: myUrl
        }).catch(err => {
          console.error(`Помилка запуску частини ${part.partId}:`, err);
          runningCount = Math.max(0, runningCount - 1);
        });
      } else {
        if (redisClient) {
          const beforeAdd = await redisClient.lLen(GLOBAL_QUEUE_NAME);
          await redisClient.lPush(GLOBAL_QUEUE_NAME, JSON.stringify(queueItem));
          const afterAdd = await redisClient.lLen(GLOBAL_QUEUE_NAME);
          
          console.log(`[${SERVER_ID}] 📝 Частину ${part.partId} додано до черги (немає вільних слотів)`);
          console.log(`   Довжина черги: ${beforeAdd} -> ${afterAdd}`);
        }
      }
    } else if (PEER_URL) {
      console.log(`[${SERVER_ID}] 🌐 Відправка частини ${part.partId} на peer: ${PEER_URL}`);
      
      try {
        const response = await axios.post(`${PEER_URL}/solve-part`, {
          taskId: part.partId,
          start: part.start,
          end: part.end,
          initialValue: part.initialValue,
          parentTaskId: mainTaskId,
          coordinatorUrl: myUrl
        }, { 
          timeout: 5000
        });
        
        console.log(`[${SERVER_ID}] ✅ Частина ${part.partId} успішно відправлена на peer:`, response.data.server);
        
        const partInfo = task.distributedParts.find(p => p.partId === part.partId);
        if (partInfo) {
          partInfo.server = response.data.server || 'peer';
        }
      } catch (err) {
        console.error(`[${SERVER_ID}] ❌ Помилка відправки частини на peer:`, err.message);
        console.log(`[${SERVER_ID}] 🔄 Fallback: обробка частини ${part.partId} локально`);
        
        if (runningCount < MAX_CONCURRENT_TASKS) {
          runningCount++;
          
          console.log(`[${SERVER_ID}] 🚀 Запуск частини ${part.partId} локально (fallback)`);
          
          runTaskPart({
            taskId: part.partId,
            start: part.start,
            end: part.end,
            initialValue: part.initialValue,
            parentTaskId: mainTaskId,
            coordinatorUrl: myUrl
          }).catch(err => {
            console.error(`Помилка запуску частини ${part.partId}:`, err);
            runningCount = Math.max(0, runningCount - 1);
          });
        } else if (redisClient) {
          queueItem.serverId = SERVER_ID;
          await redisClient.lPush(GLOBAL_QUEUE_NAME, JSON.stringify(queueItem));
          
          const partInfo = task.distributedParts.find(p => p.partId === part.partId);
          if (partInfo) {
            partInfo.server = `${SERVER_ID} (fallback queued)`;
          }
          
          console.log(`[${SERVER_ID}] 📝 Частину ${part.partId} додано до локальної черги (fallback)`);
        }
      }
    }
  }
  
  await task.save();
  console.log(`[${SERVER_ID}] ✅ Розподіл задачі ${mainTaskId} завершено`);
}

// -------------------------------------------------------------------
// ENDPOINTS
// -------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    server: SERVER_ID,
    running: runningCount,
    max: MAX_CONCURRENT_TASKS,
    available: MAX_CONCURRENT_TASKS - runningCount
  });
});

app.get('/debug/redis', async (req, res) => {
  try {
    if (!redisClient) {
      return res.json({ error: 'Redis client not initialized' });
    }
    
    const queueLength = await redisClient.lLen(GLOBAL_QUEUE_NAME);
    const allItems = await redisClient.lRange(GLOBAL_QUEUE_NAME, 0, -1);
    
    res.json({
      redis: 'connected',
      queueName: GLOBAL_QUEUE_NAME,
      queueLength,
      items: allItems.map(item => JSON.parse(item))
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/debug/network', async (req, res) => {
  const results = {
    server: SERVER_ID,
    baseUrl: BASE_URL,
    peerUrl: PEER_URL,
    ports: {
      current: SERVER_PORT
    }
  };
  
  if (PEER_URL) {
    try {
      const peerResponse = await axios.get(`${PEER_URL}/health`, { timeout: 3000 });
      results.peerConnection = {
        status: 'success',
        data: peerResponse.data
      };
    } catch (err) {
      results.peerConnection = {
        status: 'failed',
        error: err.message,
        code: err.code
      };
    }
  }
  
  res.json(results);
});

app.get('/debug/status', (req, res) => {
  res.json({
    server: SERVER_ID,
    max: MAX_CONCURRENT_TASKS,
    running: runningCount,
    available: MAX_CONCURRENT_TASKS - runningCount,
    runningTasks: Object.keys(runningTasks),
    health: 'healthy',
    timestamp: new Date().toISOString()
  });
});

app.get('/debug/tasks', async (req, res) => {
  try {
    const tasks = await Task.find({}).sort({ createdAt: -1 }).limit(10);
    const runningTaskIds = Object.keys(runningTasks);
    
    res.json({
      totalTasks: tasks.length,
      tasks: tasks.map(t => ({
        taskId: t.taskId,
        type: t.type,
        status: t.status,
        progress: t.progress,
        parentTaskId: t.parentTaskId,
        coordinatorUrl: t.coordinatorUrl,
        userId: t.userId,
        username: t.username
      })),
      runningTasks: runningTaskIds,
      runningCount
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Тестовий endpoint для перевірки callback
app.post('/test-callback', (req, res) => {
  console.log(`[${SERVER_ID}] ✅ Отримано тестовий callback:`, req.body);
  res.json({ 
    success: true, 
    server: SERVER_ID, 
    received: req.body,
    timestamp: new Date().toISOString()
  });
});

app.post('/test-coordinator', async (req, res) => {
  const { coordinatorUrl } = req.body;
  
  console.log(`[${SERVER_ID}] 📍 Тест coordinatorUrl: ${coordinatorUrl}`);
  console.log(`[${SERVER_ID}] 📍 Мій BASE_URL: ${BASE_URL}`);
  console.log(`[${SERVER_ID}] 📍 Вони рівні?: ${coordinatorUrl === BASE_URL}`);
  
  try {
    if (coordinatorUrl && coordinatorUrl !== BASE_URL) {
      const response = await axios.post(`${coordinatorUrl}/test-callback`, {
        test: true,
        from: SERVER_ID,
        timestamp: new Date().toISOString()
      }, { timeout: 3000 });
      
      console.log(`[${SERVER_ID}] ✅ Успішно достукався до ${coordinatorUrl}:`, response.data);
    }
    
    res.json({
      success: true,
      receivedCoordinatorUrl: coordinatorUrl,
      myBaseUrl: BASE_URL,
      areEqual: coordinatorUrl === BASE_URL
    });
  } catch (err) {
    console.error(`[${SERVER_ID}] ❌ Помилка тесту:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/solve', authMiddleware, async (req, res) => {
  const { number } = req.body;
  const taskId = uuidv4();
  
  if (number < 0 || isNaN(number) || number > 170) {
    return res.status(400).json({ error: 'Число має бути від 0 до 170.' });
  }
  
  console.log(`[${SERVER_ID}] 📥 Отримано задачу ${number}! від користувача ${req.username} (ID: ${req.userId})`);
  console.log(`[${SERVER_ID}] Статус: runningCount=${runningCount}, MAX=${MAX_CONCURRENT_TASKS}`);
  
  if (number > DISTRIBUTION_THRESHOLD) {
    console.log(`[${SERVER_ID}] 🔀 Задача ${number}! перевищує поріг ${DISTRIBUTION_THRESHOLD} - розподіляємо`);
    
    distributeLargeTask(number, taskId, req.userId, req.username).catch(err => {
      console.error(`Помилка розподілення задачі ${taskId}:`, err);
    });
    
    return res.json({
      success: true,
      status: 'distributed',
      taskId,
      coordinator: SERVER_ID,
      message: `Задача ${number}! розподілена між серверами`
    });
  }
  
  if (runningCount < MAX_CONCURRENT_TASKS) {
    runningCount++;
    
    console.log(`[${SERVER_ID}] 🚀 Запуск задачі ${taskId} негайно`);
    
    runTask({ taskId, number }, req.userId, req.username).catch(err => {
      console.error(`Помилка виконання задачі ${taskId}:`, err);
      runningCount = Math.max(0, runningCount - 1);
    });
    
    return res.json({
      success: true,
      status: 'started',
      taskId,
      server: SERVER_ID,
      message: `Задача запущена на сервері ${SERVER_ID}`
    });
  } else {
    try {
      if (redisClient) {
        const queueItem = {
          taskId,
          number,
          type: 'single',
          timestamp: Date.now(),
          serverId: SERVER_ID,
          status: 'queued',
          userId: req.userId,
          username: req.username
        };
        
        await redisClient.lPush(GLOBAL_QUEUE_NAME, JSON.stringify(queueItem));
        const queueLength = await redisClient.lLen(GLOBAL_QUEUE_NAME);
        
        console.log(`[${SERVER_ID}] 📝 Задачу ${taskId} додано до черги (позиція: ${queueLength})`);
        
        return res.status(202).json({
          success: true,
          status: 'queued',
          taskId,
          position: queueLength,
          server: SERVER_ID,
          message: `Задача додана до черги (позиція: ${queueLength})`
        });
      } else {
        return res.status(503).json({
          error: 'Сервер перевантажений. Спробуйте пізніше.',
          server: SERVER_ID
        });
      }
    } catch (redisErr) {
      console.error('Redis помилка:', redisErr);
      return res.status(503).json({
        error: 'Сервер перевантажений. Спробуйте пізніше.',
        server: SERVER_ID
      });
    }
  }
});

app.post('/solve-part', async (req, res) => {
  const { taskId, start, end, initialValue = "1", parentTaskId, coordinatorUrl } = req.body;
  
  console.log(`[${SERVER_ID}] 📥 Отримано частину задачі ${taskId} (${start}-${end}) від ${coordinatorUrl}`);
  console.log(`[${SERVER_ID}] Статус: runningCount=${runningCount}, MAX=${MAX_CONCURRENT_TASKS}`);
  
  if (runningCount < MAX_CONCURRENT_TASKS) {
    runningCount++;
    
    console.log(`[${SERVER_ID}] 🚀 Запуск частини ${taskId} негайно`);
    
    runTaskPart({
      taskId,
      start,
      end,
      initialValue,
      parentTaskId,
      coordinatorUrl
    }).catch(err => {
      console.error(`Помилка виконання частини ${taskId}:`, err);
      runningCount = Math.max(0, runningCount - 1);
    });
    
    res.json({
      success: true,
      status: 'part_started',
      server: SERVER_ID,
      taskId,
      range: `${start}-${end}`
    });
  } else {
    try {
      if (redisClient) {
        const queueItem = {
          taskId,
          start,
          end,
          initialValue,
          parentTaskId,
          coordinatorUrl,
          type: 'part',
          timestamp: Date.now(),
          serverId: SERVER_ID,
          status: 'queued'
        };
        
        await redisClient.lPush(GLOBAL_QUEUE_NAME, JSON.stringify(queueItem));
        
        console.log(`[${SERVER_ID}] 📝 Частину ${taskId} додано до черги`);
        
        res.status(202).json({
          success: true,
          status: 'part_queued',
          server: SERVER_ID,
          taskId,
          range: `${start}-${end}`
        });
      } else {
        res.status(503).json({
          error: 'Сервер перевантажений для частини',
          server: SERVER_ID
        });
      }
    } catch (redisErr) {
      res.status(503).json({
        error: 'Помилка черги',
        server: SERVER_ID
      });
    }
  }
});

app.post('/part-completed', async (req, res) => {
  const { partTaskId, result, mainTaskId } = req.body;
  
  console.log(`[${SERVER_ID}] ✅ Частина завершена: ${partTaskId}`);
  console.log(`[${SERVER_ID}] Результат довжина: ${result?.length || 0}`);
  console.log(`[${SERVER_ID}] Основний ID: ${mainTaskId}`);
  
  try {
    const mainTask = await Task.findOne({ taskId: mainTaskId, type: 'distributed' });
    
    if (!mainTask) {
      console.error(`[${SERVER_ID}] ❌ Основна задача ${mainTaskId} не знайдена`);
      return res.status(404).json({
        success: false,
        message: 'Основна задача не знайдена'
      });
    }
    
    if (mainTask.distributedParts) {
      const partInfo = mainTask.distributedParts.find(p => p.partId === partTaskId);
      
      if (partInfo) {
        partInfo.result = result;
        partInfo.progress = 100;
        
        const completedParts = mainTask.distributedParts.filter(p => p.progress === 100).length;
        const totalParts = mainTask.distributedParts.length;
        mainTask.progress = Math.floor((completedParts / totalParts) * 100);
        
        console.log(`[${SERVER_ID}] 📊 Прогрес задачі ${mainTaskId}: ${completedParts}/${totalParts} частин завершено`);
        
        if (completedParts === totalParts) {
          console.log(`[${SERVER_ID}] 🎉 Всі частини завершені - об'єднання результатів`);
          
          try {
            const result1 = mainTask.distributedParts.find(p => p.partId.endsWith('_part1'))?.result;
            const result2 = mainTask.distributedParts.find(p => p.partId.endsWith('_part2'))?.result;
            
            if (result1 && result2) {
              console.log(`[${SERVER_ID}] 🔄 Множення результатів...`);
              const finalResult = BigInt(result1) * BigInt(result2);
              
              mainTask.result = finalResult.toString();
              mainTask.progress = 100;
              mainTask.status = 'completed';
              mainTask.steps.push({
                server: SERVER_ID,
                step: 'Об\'єднання завершено',
                result: mainTask.result.substring(0, 50) + '...'
              });
              
              console.log(`[${SERVER_ID}] ✅ Фінальний результат: ${mainTask.result.substring(0, 50)}...`);
            } else {
              console.error(`[${SERVER_ID}] ❌ Не знайдено результатів частин`);
              mainTask.result = 'ERROR: Missing part results';
              mainTask.status = 'failed';
            }
          } catch (mergeErr) {
            console.error(`[${SERVER_ID}] ❌ Помилка об\'єднання:`, mergeErr);
            mainTask.result = 'ERROR: Merge failed';
            mainTask.status = 'failed';
          }
        }
        
        await mainTask.save();
        
        return res.json({
          success: true,
          allCompleted: mainTask.distributedParts.every(p => p.progress === 100),
          mainTaskId,
          progress: mainTask.progress
        });
      }
    }
    
    console.error(`[${SERVER_ID}] ❌ Частина ${partTaskId} не знайдена в задачі ${mainTaskId}`);
    res.status(404).json({
      success: false,
      message: 'Частина не знайдена в задачі'
    });
    
  } catch (err) {
    console.error(`[${SERVER_ID}] ❌ Помилка обробки part-completed:`, err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.get('/progress', authMiddleware, async (req, res) => {
  const { taskId } = req.query;
  
  if (!taskId) {
    return res.status(400).json({ error: 'taskId is required' });
  }
  
  try {
    const task = await Task.findOne({ taskId, userId: req.userId });
    
    if (!task) {
      if (redisClient) {
        const allTasks = await redisClient.lRange(GLOBAL_QUEUE_NAME, 0, -1);
        
        for (const taskStr of allTasks) {
          const queueTask = JSON.parse(taskStr);
          
          if (queueTask.taskId === taskId && queueTask.userId === req.userId) {
            return res.json({
              taskId,
              number: queueTask.number || queueTask.end,
              status: 'Queued',
              progress: 0,
              server: queueTask.serverId || 'queue',
              type: queueTask.type || 'single',
              message: 'Задача в черзі'
            });
          }
        }
      }
      
      return res.status(404).json({ error: 'Завдання не знайдено.' });
    }
    
    res.json({
      taskId: task.taskId,
      number: task.number,
      status: task.status || (task.progress === 100 ? 'Completed' : 
              task.result === 'ERROR' ? 'Failed' : 'In Progress'),
      progress: task.progress || 0,
      currentResult: task.result,
      server: task.server,
      type: task.type,
      parts: task.distributedParts || [],
      steps: task.steps || [],
      message: task.result === 'Distribution in progress' 
        ? 'Розподілення між серверами...' 
        : ''
    });
    
  } catch (err) {
    console.error('Помилка отримання прогресу:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/cancel', authMiddleware, async (req, res) => {
  const { taskId } = req.body;
  
  console.log(`[${SERVER_ID}] ❌ Скасування задачі ${taskId} користувачем ${req.username}`);
  
  if (runningTasks[taskId]) {
    try {
      await runningTasks[taskId].terminate();
      delete runningTasks[taskId];
      runningCount = Math.max(0, runningCount - 1);
    } catch (err) {
      console.error(`Помилка скасування worker ${taskId}:`, err);
    }
  }
  
  if (redisClient) {
    try {
      const allTasks = await redisClient.lRange(GLOBAL_QUEUE_NAME, 0, -1);
      
      for (let i = 0; i < allTasks.length; i++) {
        const taskInQueue = JSON.parse(allTasks[i]);
        
        if (taskInQueue.taskId === taskId && taskInQueue.userId === req.userId) {
          await redisClient.lRem(GLOBAL_QUEUE_NAME, 1, allTasks[i]);
          console.log(`[${SERVER_ID}] ✅ Задачу ${taskId} видалено з черги Redis.`);
          break;
        }
      }
    } catch (redisErr) {
      console.error('Redis помилка при скасуванні:', redisErr);
    }
  }
  
  const task = await Task.findOne({ taskId, userId: req.userId });
  
  if (task) {
    task.result = 'CANCELLED';
    task.progress = 0;
    task.status = 'cancelled';
    task.steps.push({
      server: SERVER_ID,
      step: 'Скасовано користувачем',
      result: null
    });
    
    await task.save();
  }
  
  res.json({ success: true, taskId });
});

app.get('/history', authMiddleware, async (req, res) => {
  try {
    const tasks = await Task.find({
      userId: req.userId,
      $or: [
        { status: 'completed' },
        { status: 'failed' },
        { status: 'cancelled' }
      ]
    })
      .sort({ createdAt: -1 })
      .limit(50);
    
    res.json({ tasks });
  } catch (err) {
    console.error('Помилка отримання історії:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/status', (req, res) => {
  res.json({
    server: SERVER_ID,
    max: MAX_CONCURRENT_TASKS,
    running: runningCount,
    available: MAX_CONCURRENT_TASKS - runningCount,
    health: 'healthy'
  });
});

app.get('/queue-status', async (req, res) => {
  try {
    let queueLength = 0;
    let tasks = [];
    
    if (redisClient) {
      queueLength = await redisClient.lLen(GLOBAL_QUEUE_NAME);
      const allTasks = await redisClient.lRange(GLOBAL_QUEUE_NAME, 0, -1);
      tasks = allTasks.map(t => JSON.parse(t)).reverse();
    }
    
    res.json({
      success: true,
      queueLength,
      tasks,
      servers: [{
        serverId: SERVER_ID,
        running: runningCount,
        max: MAX_CONCURRENT_TASKS,
        availableSlots: MAX_CONCURRENT_TASKS - runningCount,
        health: 'healthy'
      }],
      totalRunning: runningCount,
      totalCapacity: MAX_CONCURRENT_TASKS
    });
  } catch (err) {
    console.error('Помилка отримання статусу черги:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------------
// ПРОЦЕСИНГ ЧЕРГИ
// -------------------------------------------------------------------
async function processQueue() {
  if (!redisClient || isQueueProcessing) {
    return;
  }
  
  isQueueProcessing = true;
  
  try {
    const availableSlots = MAX_CONCURRENT_TASKS - runningCount;
    
    console.log(`[${SERVER_ID}] 🔍 processQueue: runningCount=${runningCount}, availableSlots=${availableSlots}`);
    
    if (availableSlots <= 0) {
      console.log(`[${SERVER_ID}] ⏹️ Немає вільних слотів`);
      return;
    }
    
    for (let i = 0; i < availableSlots; i++) {
      try {
        const queueLength = await redisClient.lLen(GLOBAL_QUEUE_NAME);
        
        console.log(`[${SERVER_ID}] 📊 Довжина черги: ${queueLength}`);
        
        if (queueLength === 0) {
          console.log(`[${SERVER_ID}] 📭 Черга порожня`);
          break;
        }
        
        const taskStr = await redisClient.rPop(GLOBAL_QUEUE_NAME);
        
        if (!taskStr) {
          console.log(`[${SERVER_ID}] ⚠️ Не вдалося витягнути задачу`);
          break;
        }
        
        const taskData = JSON.parse(taskStr);
        
        console.log(`[${SERVER_ID}] 📤 Витягнуто задачу з черги: ${taskData.taskId}`, {
          type: taskData.type,
          userId: taskData.userId
        });
        
        runningCount++;
        
        if (taskData.type === 'part') {
          runTaskPart({
            taskId: taskData.taskId,
            start: taskData.start,
            end: taskData.end,
            initialValue: taskData.initialValue || "1",
            parentTaskId: taskData.parentTaskId,
            coordinatorUrl: taskData.coordinatorUrl
          }).catch(err => {
            console.error(`Помилка виконання частини ${taskData.taskId}:`, err);
            runningCount = Math.max(0, runningCount - 1);
          });
        } else {
          runTask({
            taskId: taskData.taskId,
            number: taskData.number
          }, taskData.userId, taskData.username).catch(err => {
            console.error(`Помилка виконання задачі ${taskData.taskId}:`, err);
            runningCount = Math.max(0, runningCount - 1);
          });
        }
      } catch (taskErr) {
        console.error('Помилка обробки задачі з черги:', taskErr);
        continue;
      }
    }
  } catch (err) {
    console.error('Критична помилка в processQueue:', err);
  } finally {
    isQueueProcessing = false;
  }
}

// Запускаємо обробку черги кожні 2 секунди
console.log(`[${SERVER_ID}] ⏰ Queue processing interval started (every 2000ms)`);

setInterval(() => {
  console.log(`[${SERVER_ID}] ⏰ Interval tick at ${new Date().toISOString()}`);
  processQueue().catch(err => {
    console.error('Помилка в processQueue interval:', err);
  });
}, 2000);

// -------------------------------------------------------------------
// ЗАПУСК СЕРВЕРА
// -------------------------------------------------------------------

app.listen(SERVER_PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер ${SERVER_ID} запущено на порту ${SERVER_PORT}`);
  console.log(`🔧 Максимум одночасних задач: ${MAX_CONCURRENT_TASKS}`);
  console.log(`📊 Поріг розподілу: ${DISTRIBUTION_THRESHOLD}`);
  if (PEER_URL) console.log(`🤝 Peer сервер: ${PEER_URL}`);
  console.log(`🏠 Base URL: ${BASE_URL}`);
});