// require('dotenv').config();
// const express = require('express');
// const bodyParser = require('body-parser');
// const cors = require('cors');
// const axios = require('axios');
// const { v4: uuidv4 } = require('uuid');

// const app = express();
// app.use(bodyParser.json());
// app.use(cors({ origin: 'http://localhost:5173' }));

// // Сервери обчислень
// const servers = [
//   { url: 'http://localhost:8001', currentTaskId: null },
//   { url: 'http://localhost:8002', currentTaskId: null },
// ];

// // Черга задач
// const taskQueue = [];

// // 🔹 Перевіряємо, який сервер вільний
// async function getFreeServer() {
//   for (const server of servers) {
//     if (!server.currentTaskId) return server; // вільний сервер

//     try {
//       const res = await axios.get(`${server.url}/progress`, { params: { taskId: server.currentTaskId } });
//       if (res.data.progress === 100) {
//         server.currentTaskId = null; // задача завершена
//         return server;
//       }
//     } catch {
//       // Сервер не відповідає – вважаємо його вільним
//       server.currentTaskId = null;
//       return server;
//     }
//   }
//   return null; // усі сервери зайняті
// }

// // 🔹 Обробка задачі (черга + перевірка вільного сервера)
// async function handleTask(n, taskId) {
//   const server = await getFreeServer();
//   if (!server) {
//     // ставимо в чергу, якщо немає вільного сервера
//     taskQueue.push({ n, taskId });
//     return;
//   }

//   server.currentTaskId = taskId;

//   try {
//     await axios.post(`${server.url}/solve`, { number: n, taskId });
//   } catch (err) {
//     console.warn(`Сервер ${server.url} не відповідає для task ${taskId}`);
//     server.currentTaskId = null;
//     taskQueue.push({ n, taskId }); // повертаємо задачу в чергу
//   } finally {
//     // після завершення – перевіряємо чергу
//     if (taskQueue.length > 0) {
//       const next = taskQueue.shift();
//       handleTask(next.n, next.taskId);
//     }
//   }
// }

// // 🔹 Створення задачі
// app.post('/solve', async (req, res) => {
//   const n = Number(req.body.number);
//   if (isNaN(n) || n < 0) return res.status(400).json({ error: 'Невірне число' });
//   if (n > 170) return res.status(400).json({ error: 'Максимум 170' });

//   const taskId = uuidv4(); // унікальний taskId
//   handleTask(n, taskId);    // запускаємо асинхронно
//   res.json({ taskId });
// });

// // 🔹 Прогрес задачі
// app.get('/progress', async (req, res) => {
//   const { taskId } = req.query;
//   for (const server of servers) {
//     try {
//       const response = await axios.get(`${server.url}/progress`, { params: { taskId } });
//       if (response.data && response.data.steps?.length > 0) return res.json(response.data);
//     } catch {}
//   }
//   res.status(404).json({ error: 'Задача не знайдена' });
// });

// // 🔹 Історія задач
// app.get('/history', async (req, res) => {
//   let allTasks = [];
//   for (const server of servers) {
//     try {
//       const response = await axios.get(`${server.url}/history`);
//       if (Array.isArray(response.data)) allTasks = allTasks.concat(response.data);
//     } catch {}
//   }
//   allTasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
//   res.json(allTasks);
// });

// // 🔹 Скасування задачі
// app.post('/cancel', async (req, res) => {
//   const { taskId } = req.body;
//   let canceled = false;

//   for (const server of servers) {
//     try {
//       await axios.post(`${server.url}/cancel`, { taskId });
//       canceled = true;
//       if (server.currentTaskId === taskId) server.currentTaskId = null;
//     } catch {}
//   }

//   if (canceled) return res.json({ status: 'Задача скасована' });
//   return res.status(500).json({ error: 'Не вдалося скасувати задачу' });
// });

// app.listen(8000, () => console.log('⚖️ Load Balancer running on http://localhost:8000'));
