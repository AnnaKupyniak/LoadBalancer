import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';

export default function App() {
  const [number, setNumber] = useState('');
  const [tasks, setTasks] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);

  const tasksRef = useRef(tasks);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  const startTask = async () => {
    const n = Number(number);
    if (isNaN(n) || n < 0 || n > 170) {
      return alert("Невірне число (0–170)");
    }

    setLoading(true);
    try {
      const taskId = Date.now().toString();
      let response;

      if (n <= 70) {
        response = await axios.post('/api/solve', { number: n, taskId });

        if (response.data.status === 'queued') {
          setTasks(prev => [...prev, {
            taskId,
            number: n,
            progress: 0,
            steps: [],
            status: 'queued',
            queuePosition: response.data.position,
            type: 'single',
            server: 'Server 1 (в черзі)',
            result: null,
            message: response.data.message || ''
          }]);
        } else {
          setTasks(prev => [...prev, {
            taskId,
            number: n,
            progress: 0,
            steps: [],
            status: 'started',
            type: 'single',
            server: response.data.server || 'Server 1',
            result: null
          }]);
        }

      } else {
        response = await axios.post('/api/solve-distributed', { number: n, taskId });

        setTasks(prev => [...prev, {
          taskId,
          number: n,
          progress: 0,
          steps: [],
          status: 'started',
          type: 'distributed',
          distributedParts: response.data.parts || 2,
          message: response.data.message || '',
          partProgress: [],
          result: null,
          server: response.data.server || ''
        }]);
      }

      setNumber('');
    } catch (err) {
      alert("Помилка запуску задачі: " + (err.response?.data?.error || err.message));
    } finally {
      setLoading(false);
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
    } catch (err) {
      alert("Не вдалося скасувати задачу");
    }
  };

  const fetchTaskProgress = async (task) => {
    try {
      const res = await axios.get('/api/progress', {
        params: { taskId: task.taskId }
      });

      if (task.status === 'queued') return task;

      return { 
        ...task,
        progress: res.data.progress || 0,
        steps: res.data.steps || [],
        status: res.data.progress >= 100 ? 'completed' : 'started',
        type: res.data.type || task.type,
        result: res.data.result || task.result,
        distributedParts: res.data.parts,
        partProgress: res.data.partProgress || [],
        server: res.data.server || task.server,
        message: res.data.message || '',
      };
    } catch (err) {
      if (err.response?.status === 404 && task.status !== 'queued') {
        return { ...task, status: 'queued', message: 'Очікує на виконання...' };
      }
      return task;
    }
  };

  const checkQueueStatus = async () => {
    try {
      const currentTasks = tasksRef.current;
      const queuedTasks = currentTasks.filter(t => t.status === 'queued');

      if (queuedTasks.length === 0) return;

      for (const task of queuedTasks) {
        try {
          const res = await axios.get('/api/progress', {
            params: { taskId: task.taskId }
          });

          if (res.data.success) {
            setTasks(prev =>
              prev.map(t =>
                t.taskId === task.taskId
                  ? {
                      ...t,
                      status: 'started',
                      progress: res.data.progress || 0,
                      server: res.data.server || t.server,
                      queuePosition: undefined
                    }
                  : t
              )
            );
          }
        } catch (err) {}
      }
    } catch (err) {}
  };

  useEffect(() => {
    const progressInterval = setInterval(async () => {
      const currentTasks = tasksRef.current;
      const active = currentTasks.filter(t =>
        t.status === 'started' && t.progress < 100
      );

      if (active.length === 0) return;

      try {
        const updated = await Promise.all(active.map(fetchTaskProgress));
        setTasks(prev =>
          prev.map(t => updated.find(u => u.taskId === t.taskId) || t)
        );
      } catch {}
    }, 1000);

    const queueInterval = setInterval(checkQueueStatus, 3000);

    return () => {
      clearInterval(progressInterval);
      clearInterval(queueInterval);
    };
  }, []);

  const fetchHistory = async () => {
    try {
      const res = await axios.get('/api/history');
      setHistory(res.data.tasks || res.data || []);
    } catch {
      alert("Не вдалося отримати історію задач");
    }
  };

  const formatLargeNumber = (num) => {
    if (!num || num === "1" || num === "обчислюється...") return '';
    if (num.length <= 50) return num;
    return `${num.substring(0, 30)}...${num.substring(num.length - 20)}`;
  };

  const renderProgress = (task) => {
    if (task.status === 'queued') {
      return (
        <div>
          В черзі (позиція: {task.queuePosition || '?'})
          <br />
          <small>{task.message || 'Очікує на вільний слот...'}</small>
        </div>
      );
    }

    if (task.type === 'distributed' && task.partProgress.length > 0) {
      return (
        <div>
          <div>Загальний прогрес: {task.progress.toFixed(1)}%</div>
          {task.partProgress.map((p, i) => (
            <div key={i}>
              Частина {i + 1}: {p.progress?.toFixed(1) || 0}%
            </div>
          ))}
        </div>
      );
    }

    return <div>Прогрес: {task.progress.toFixed(1)}%</div>;
  };

  const renderTaskStatus = (task) => {
    const statusMap = {
      'completed': 'Завершено',
      'started': 'Виконується',
      'queued': 'В черзі',
      'cancelled': 'Скасовано'
    };
    return statusMap[task.status] || task.status;
  };

  return (
    <div>
      <h1>Обчислення факторіалів</h1>

      <div>
        <ul>
          <li>0–70: один сервер</li>
          <li>71–170: розподіл на 2 сервери</li>
        </ul>
      </div>

      <div>
        <input
          type="number"
          value={number}
          onChange={e => setNumber(e.target.value)}
          placeholder="Введіть число (0–170)"
          min="0"
          max="170"
        />

        <button onClick={startTask} disabled={loading}>
          {loading ? 'Запуск...' : 'Додати задачу'}
        </button>

        <button onClick={fetchHistory}>
          Історія задач
        </button>
      </div>

      <h2>Активні задачі</h2>

      {tasks.length === 0 ? (
        <p>Немає активних задач</p>
      ) : (
        <div>
          {tasks.map(task => (
            <div key={task.taskId}>
              <h3>
                {task.number}! (ID: {task.taskId.slice(-8)})
              </h3>

              <div>
                <strong>Статус:</strong> {renderTaskStatus(task)}
              </div>

              {task.server && (
                <div>
                  <strong>Сервер:</strong> {task.server}
                </div>
              )}

              {task.message && (
                <div>
                  <em>{task.message}</em>
                </div>
              )}

              {renderProgress(task)}

              {task.result && task.result !== "1" && (
                <div>
                  <h4>Результат:</h4>
                  <div>{formatLargeNumber(task.result)}</div>
                </div>
              )}

              <div>
                {(task.status === 'started' || task.status === 'queued') && (
                  <button onClick={() => cancelTask(task.taskId)}>
                    Скасувати
                  </button>
                )}
              </div>

              {task.steps.length > 0 && (
                <details>
                  <summary>Кроки ({task.steps.length})</summary>
                  <table>
                    <thead>
                      <tr>
                        <th>Сервер</th>
                        <th>Крок</th>
                        <th>Результат</th>
                      </tr>
                    </thead>
                    <tbody>
                      {task.steps.reverse().map((step, i) => (
                        <tr key={i}>
                          <td>{step.server}</td>
                          <td>{step.step}</td>
                          <td>{formatLargeNumber(step.result)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </div>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <>
          <h2>Історія задач ({history.length})</h2>
          <table>
            <thead>
              <tr>
                <th>Число</th>
                <th>Результат</th>
                <th>Тип</th>
                <th>Сервер</th>
                <th>Дата</th>
              </tr>
            </thead>
            <tbody>
              {history.map(h => (
                <tr key={h._id}>
                  <td><strong>{h.number}!</strong></td>
                  <td>{formatLargeNumber(h.result)}</td>
                  <td>
                    {h.type === 'single'
                      ? 'Один сервер'
                      : h.type === 'distributed'
                      ? 'Розподілено'
                      : h.type === 'part'
                      ? 'Частина'
                      : h.type}
                  </td>
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