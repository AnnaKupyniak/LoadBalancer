const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());
app.use(cors({ origin: 'http://localhost:5173' }));

// Сервери обчислень
const servers = [
  'http://localhost:8001', // Сервер 1
  'http://localhost:8002', // Сервер 2
];

let current = 0; // для round-robin

// 🔹 Запуск задачі через доступний сервер
app.post('/solve', async (req, res) => {
  const n = Number(req.body.number);

  if (isNaN(n) || n < 0) return res.status(400).json({ error: 'Невірне число' });
  if (n > 170) return res.status(400).json({ error: 'Максимум 170' });
  if (n === 0) return res.json({ taskId: 'instant', progress: 100, steps: [{ server: 'Load Balancer', step: '0! = 1', result: 1 }], result: 1 });

  let tried = 0;
  while (tried < servers.length) {
    const server = servers[current];
    current = (current + 1) % servers.length;

    try {
      const response = await axios.post(`${server}/solve`, { number: n });
      return res.json(response.data);
    } catch (err) {
      console.warn(`Сервер ${server} не відповідає, пробуємо наступний...`);
      tried++;
    }
  }

  res.status(503).json({ error: 'Усі сервери недоступні' });
});

// 🔹 Отримання прогресу
app.get('/progress', async (req, res) => {
  const { taskId } = req.query;

  for (const server of servers) {
    try {
      const response = await axios.get(`${server}/progress`, { params: { taskId } });
      if (response.data && response.data.steps.length > 0) return res.json(response.data);
    } catch (err) {
      console.warn(`Не вдалося отримати прогрес від ${server}`);
    }
  }

  res.status(503).json({ error: 'Усі сервери недоступні' });
});
app.get('/history', async (req, res) => {
  let allTasks = [];

  for (const server of servers) {
    try {
      const response = await axios.get(`${server}/history`);
      if (Array.isArray(response.data)) {
        allTasks = allTasks.concat(response.data);
      }
    } catch (err) {
      console.warn(`Не вдалося отримати історію від ${server}`);
    }
  }

  // Сортуємо по createdAt, останні зверху
  allTasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(allTasks);
});



app.listen(8000, () => console.log('⚖️ Load Balancer running on http://localhost:8000'));
