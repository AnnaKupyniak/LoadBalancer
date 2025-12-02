import React, { useState, useEffect } from 'react';
import axios from 'axios';

export default function App() {
  const [number, setNumber] = useState('');
  const [tasks, setTasks] = useState([]);
  const [history, setHistory] = useState([]);

  const startTask = async () => {
    const n = Number(number);
    if (isNaN(n) || n < 0 || n > 170) {
      return alert("Невірне число (0–170)");
    }

    try {
      const taskId = Date.now().toString();
      await axios.post('/api/solve', { number: n, taskId });

      setTasks(prev => [...prev, {
        taskId,
        number: n,
        progress: 0,
        steps: [],
        status: 'started'
      }]);

      setNumber('');
    } catch (err) {
      console.error(err);
      alert("Помилка запуску задачі");
    }
  };

  const cancelTask = async (taskIdToCancel) => {
    try {
      await axios.post('/api/cancel', { taskId: taskIdToCancel });

      setTasks(prev =>
        prev.map(task =>
          task.taskId === taskIdToCancel
            ? { ...task, status: 'cancelled', progress: 0 }
            : task
        )
      );

      alert("Задача скасована");
    } catch (err) {
      console.error(err);
      alert("Не вдалося скасувати задачу");
    }
  };

  useEffect(() => {
    const activeTasks = tasks.filter(t => t.status === 'started' && t.progress < 100);
    if (activeTasks.length === 0) return;

    const interval = setInterval(async () => {
      try {
        const updated = await Promise.all(
          activeTasks.map(async task => {
            try {
              const res = await axios.get('/api/progress', {
                params: { taskId: task.taskId }
              });
              return {
                ...task,
                progress: res.data.progress,
                steps: res.data.steps || [],
                status: res.data.progress === 100 ? 'completed' : 'started'
              };
            } catch {
              return task;
            }
          })
        );

        setTasks(prev =>
          prev.map(t =>
            updated.find(u => u.taskId === t.taskId) || t
          )
        );
      } catch (err) {
        console.error(err);
      }
    }, 500);

    return () => clearInterval(interval);
  }, [tasks]);

  const fetchHistory = async () => {
    try {
      const res = await axios.get('/api/history');
      setHistory(res.data);
    } catch (err) {
      console.error(err);
      alert("Не вдалося отримати історію задач");
    }
  };

  return (
    <div>
      <h1>Факторіал</h1>

      <input
        type="number"
        value={number}
        onChange={e => setNumber(e.target.value)}
        placeholder="Введіть число (0–170)"
      />

      <button onClick={startTask}>Додати нову задачу</button>
      <button onClick={fetchHistory}>Історія задач</button>

      <h2>Активні задачі</h2>

      {tasks.length === 0 ? (
        <p>Немає активних задач</p>
      ) : (
        tasks.map(task => (
          <div key={task.taskId}>
            <p>Задача #{task.taskId}</p>
            <p>Число: {task.number}</p>
            <p>Статус: {task.status}</p>

            {task.status === 'started' && (
              <button onClick={() => cancelTask(task.taskId)}>
                Скасувати
              </button>
            )}

            <p>Прогрес: {task.progress}%</p>

            {task.steps.length > 0 && (
              <table border="1">
                <thead>
                  <tr>
                    <th>Сервер</th>
                    <th>Крок</th>
                    <th>Результат</th>
                  </tr>
                </thead>
                <tbody>
                  {task.steps.map((s, i) => (
                    <tr key={i}>
                      <td>{s.server}</td>
                      <td>{s.step}</td>
                      <td>{s.result}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <hr />
          </div>
        ))
      )}

      {history.length > 0 && (
        <>
          <h2>Історія задач</h2>
          <table border="1">
            <thead>
              <tr>
                <th>Task ID</th>
                <th>Число</th>
                <th>Результат</th>
                <th>Сервер</th>
                <th>Дата</th>
              </tr>
            </thead>
            <tbody>
              {history.map(h => (
                <tr key={h._id}>
                  <td>{h._id}</td>
                  <td>{h.number}</td>
                  <td>{h.result}</td>
                  <td>{h.server}</td>
                  <td>{new Date(h.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
