import React, { useState, useEffect } from 'react';
import axios from 'axios';

export default function App() {
  const [number, setNumber] = useState('');
  const [taskId, setTaskId] = useState(null);
  const [progress, setProgress] = useState(0);
  const [steps, setSteps] = useState([]);
  const [history, setHistory] = useState([]); // історія задач
  const [showHistory, setShowHistory] = useState(false);

  const startTask = async () => {
    const n = Number(number);

    // 🔒 Перевірка обмежень
    if (isNaN(n)) {
      alert("Будь ласка, введіть число.");
      return;
    }
    if (n < 0) {
      alert("❌ Число не може бути від’ємним.");
      return;
    }
    if (n > 170) {
      alert("⚠️ Значення не може перевищувати 170, бо результат буде нескінченністю у JavaScript.");
      return;
    }

    const res = await axios.post('http://localhost:8000/solve', { number: n });
    setTaskId(res.data.taskId);
    setProgress(0);
    setSteps([]);
  };

  useEffect(() => {
    if (!taskId) return;
    const interval = setInterval(async () => {
      const res = await axios.get('http://localhost:8000/progress', { params: { taskId } });
      setProgress(res.data.progress);
      setSteps(res.data.steps);
      if (res.data.progress === 100) clearInterval(interval);
    }, 500);

    return () => clearInterval(interval);
  }, [taskId]);

  const fetchHistory = async () => {
    try {
      const res = await axios.get('http://localhost:8000/history');
      setHistory(res.data);
      setShowHistory(true);
    } catch (err) {
      alert('❌ Не вдалося отримати історію задач');
      console.error(err);
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
      <button onClick={startTask}>Запустити</button>
      <button onClick={fetchHistory} style={{ marginLeft: '10px' }}>Історія задач</button>

      <p>Прогрес: {progress.toFixed(1)}%</p>

      <table border="1">
        <thead>
          <tr>
            <th>Сервер</th>
            <th>Крок множення</th>
            <th>Результат</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s, idx) => (
            <tr key={idx}>
              <td>{s.server}</td>
              <td>{s.step}</td>
              <td>{s.result}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {showHistory && (
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
              {history.map((h) => (
                <tr key={h._id || h.id}>
                  <td>{h._id || h.id}</td>
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
