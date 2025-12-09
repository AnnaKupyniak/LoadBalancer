import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

const HomePage = ({ user, onLogout, api }) => {
  const [number, setNumber] = useState('')
  const [tasks, setTasks] = useState([])
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [balancerStatus, setBalancerStatus] = useState({
    status: 'checking',
    message: 'Перевірка балансувальника...'
  })

  const tasksRef = useRef(tasks)
  const navigate = useNavigate()

  useEffect(() => {
    tasksRef.current = tasks
    console.log(`[Frontend] Завдання оновлено:`, tasks.length, 'задач')
    tasks.forEach((task, index) => {
      console.log(`[Frontend] Задача ${index + 1}: ${task.taskId.slice(-8)}, статус: ${task.status}, прогрес: ${task.progress}%`)
    })
  }, [tasks])

  useEffect(() => {
    const checkBalancer = async () => {
      try {
        const response = await fetch('/health')
        if (response.ok) {
          setBalancerStatus({
            status: 'online',
            message: 'Система готова до роботи'
          })
        }
      } catch (err) {
        setBalancerStatus({
          status: 'offline',
          message: 'Балансувальник недоступний. Спробуйте пізніше.'
        })
      }
    }

    checkBalancer()
    const interval = setInterval(checkBalancer, 10000)
    return () => clearInterval(interval)
  }, [])

  const startTask = async () => {
    if (balancerStatus.status !== 'online') {
      setError('Система тимчасово недоступна. Спробуйте пізніше.')
      return
    }

    const n = Number(number)
    if (isNaN(n) || n < 0 || n > 170) {
      setError("Невірне число. Введіть число від 0 до 170")
      return
    }

    setError('')
    setLoading(true)
    
    try {
      const response = await api.post('/solve', { number: n })
      console.log(`[Frontend] Старт задачі ${n}!, відповідь:`, response.data)

      const newTask = {
        taskId: response.data.taskId,
        number: n,
        progress: 0,
        steps: [],
        status: response.data.status === 'queued' ? 'queued' : 
                response.data.status === 'distributed' ? 'distributed' : 'started',
        queuePosition: response.data.position,
        type: n > 70 ? 'distributed' : 'single',
        server: response.data.server || response.data.coordinator || 'Балансується...',
        result: null,
        message: response.data.message || '',
        distributedParts: [],
        partProgress: [],
        createdAt: new Date().toISOString(),
        completedAt: null // поле для часу завершення
      }

      console.log(`[Frontend] Створено нову задачу:`, newTask)
      setTasks(prev => [newTask, ...prev])
      setNumber('')
    } catch (err) {
      console.error('Помилка при створенні задачі:', err)
      if (err.response?.status === 401) {
        setError('Сесія закінчилася. Будь ласка, увійдіть знову.')
        onLogout()
        navigate('/login')
      } else if (err.response?.status === 502 || err.response?.status === 503) {
        setError('Сервер тимчасово недоступний. Можливо, перевантаження.')
        setBalancerStatus({
          status: 'offline',
          message: 'Проблема з балансувальником'
        })
      } else {
        setError(
          "Помилка запуску задачі: " +
            (err.response?.data?.error || err.message || 'Невідома помилка')
        )
      }
    } finally {
      setLoading(false)
    }
  }

  const cancelTask = async taskId => {
    try {
      await api.post('/cancel', { taskId })

      setTasks(prev =>
        prev.map(task =>
          task.taskId === taskId
            ? {
                ...task,
                status: 'cancelled',
                progress: 0,
                message: 'Скасовано користувачем'
              }
            : task
        )
      )
    } catch (err) {
      setError(
        "Не вдалося скасувати задачу: " +
          (err.response?.data?.error || err.message)
      )
    }
  }

  const fetchTaskProgress = async task => {
    try {
      console.log(`[Frontend] Запит прогресу для ${task.taskId.slice(-8)}`)
      
      const res = await api.get('/progress', {
        params: { taskId: task.taskId }
      })

      const data = res.data
      console.log(`[Frontend] Отримано прогрес для ${task.taskId.slice(-8)}:`, {
        status: data.status,
        progress: data.progress,
        type: data.type,
        resultLength: data.currentResult?.length || 0
      })

      const getFrontendStatus = (backendStatus, backendProgress) => {
        const status = backendStatus?.toLowerCase() || ''
        const progress = backendProgress || 0
        
        if (status === 'completed' || progress === 100) return 'completed'
        if (status === 'cancelled' || status === 'failed') return status
        if (status === 'queued') return 'queued'
        if (status === 'coordinating' || status === 'distributed') return 'distributed'
        if (progress > 0 && progress < 100) return 'started'
        if (status === 'processing' || status === 'started') return 'started'
        return 'started'
      }

      const frontendStatus = getFrontendStatus(data.status, data.progress)
      const progress = data.progress || 0

      const partProgress = (data.parts || []).map((p, i) => ({
        range: `${p.start || 0}-${p.end || 0}`,
        progress: p.progress || 0,
        server: p.server || '??',
        result: p.result,
        status: p.progress === 100 ? 'completed' : 'processing'
      }))

      const updatedTask = {
        ...task,
        progress: progress,
        steps: data.steps || task.steps || [],
        status: frontendStatus,
        type: data.type || task.type,
        result: data.currentResult || task.result,
        distributedParts: data.parts || task.distributedParts,
        partProgress: partProgress,
        server: data.server || task.server,
        message: data.message || task.message || '',
        queuePosition: undefined,
        completedAt: task.completedAt || (frontendStatus === 'completed' ? new Date().toISOString() : null)
      }

      console.log(`[Frontend] Оновлено ${task.taskId.slice(-8)}: статус=${frontendStatus}, прогрес=${progress}%`)
      return updatedTask

    } catch (err) {
      console.error('Помилка отримання прогресу:', err)
      if (err.response?.status === 404) {
        console.log(`[Frontend] Задача ${task.taskId.slice(-8)} не знайдена на сервері`)
        return {
          ...task,
          status: 'failed',
          message: 'Задача не знайдена на сервері'
        }
      }
      if (err.response?.status === 401) {
        onLogout()
        navigate('/login')
      }
      return task
    }
  }

  useEffect(() => {
    const progressInterval = setInterval(async () => {
      const currentTasks = tasksRef.current
    
      const active = currentTasks.filter(t => {
        if (t.status === 'completed' || t.status === 'cancelled' || t.status === 'failed') return false
        if (t.status === 'queued') return true
        if (t.type === 'distributed') return true
        if (t.progress < 100) return true
        return false
      })

      if (active.length === 0) {
        console.log(`[Frontend] Немає активних задач для оновлення`)
        return
      }

      console.log(`[Frontend] Оновлюю ${active.length} активних задач`)

      try {
        const updated = await Promise.all(active.map(fetchTaskProgress))
        
        setTasks(prev =>
          prev.map(t => {
            const updatedTask = updated.find(u => u.taskId === t.taskId)
            if (updatedTask) {
              if (t.progress !== updatedTask.progress || t.status !== updatedTask.status) {
                console.log(`[Frontend] Зміна ${t.taskId.slice(-8)}: ${t.status}→${updatedTask.status}, ${t.progress}%→${updatedTask.progress}%`)
              }
              return updatedTask
            }
            return t
          })
        )
      } catch (err) {
        console.error('Помилка оновлення прогресу:', err.message)
      }
    }, 2000)

    return () => clearInterval(progressInterval)
  }, [])

  const fetchHistory = async () => {
    try {
      const res = await api.get('/history')
      setHistory(res.data.tasks || res.data || [])
      console.log(`[Frontend] Завантажено історію: ${res.data.tasks?.length || res.data?.length || 0} записів`)
    } catch (err) {
      setError(
        "Не вдалося отримати історію: " +
          (err.response?.data?.error || err.message)
      )
    }
  }

  const formatLargeNumber = num => {
    if (!num || num === '1' || num === 'обчислюється...' || num === 'Distribution in progress') return num || ''
    if (num.length <= 50) return num
    return `${num.substring(0, 30)}...${num.substring(num.length - 20)}`
  }

  const renderProgress = task => {
    if (task.status === 'queued') {
      return (
        <div className="task-queued">
          <strong>В черзі</strong>{' '}
          {task.queuePosition && `(позиція: ${task.queuePosition})`}
          <div className="task-message">
            {task.message || 'Очікує на вільний слот...'}
          </div>
        </div>
      )
    }

    if (task.type === 'distributed') {
      const parts = task.partProgress || []
      const completedParts = parts.filter(p => p.progress === 100).length
      const totalParts = parts.length
      
      return (
        <div className="distributed-progress">
          <div>
            <strong>Загальний прогрес:</strong>{' '}
            {task.progress.toFixed(1)}%
            {totalParts > 0 && (
              <span className="parts-count">
                ({completedParts}/{totalParts} частин готово)
              </span>
            )}
          </div>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${task.progress}%` }}
            ></div>
          </div>

          {parts.length > 0 && (
            <details className="parts-details">
              <summary>Деталі частин ({parts.length})</summary>
              <div className="parts-list">
                {parts.map((p, i) => (
                  <div key={i} className="part-item">
                    <div className="part-header">
                      Частина {i + 1} ({p.range}):{' '}
                      <strong>{p.progress?.toFixed(1) || 0}%</strong>
                    </div>
                    <div className="part-subtext">
                      Сервер: {p.server}
                      {p.progress === 100 ? ' — Готово' : ' — Обчислюється...'}
                    </div>
                    <div className="progress-bar small">
                      <div
                        className="progress-fill"
                        style={{ width: `${p.progress}%` }}
                      ></div>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )
    }

    return (
      <div className="single-progress">
        <div>
          Прогрес: <strong>{task.progress.toFixed(1)}%</strong>
        </div>
        <div className="progress-bar">
          <div
            className="progress-fill"
            style={{ width: `${task.progress}%` }}
          ></div>
        </div>
        {task.message && (
          <div className="task-message">{task.message}</div>
        )}
      </div>
    )
  }

  const renderTaskStatus = task => {
    const statusMap = {
      completed: 'Завершено',
      started: 'Виконується',
      queued: 'В черзі',
      distributed: 'Розподілено',
      cancelled: 'Скасовано',
      failed: 'Помилка',
      processing: 'Обробляється'
    }
    return statusMap[task.status] || task.status
  }

  const getStatusColor = status => {
    const colorMap = {
      completed: '#4caf50',
      started: '#2196f3',
      queued: '#ff9800',
      distributed: '#9c27b0',
      cancelled: '#9e9e9e',
      failed: '#f44336',
      processing: '#2196f3'
    }
    return colorMap[status] || '#000'
  }

  return (
    <div className="home-container">
      <header className="home-header">
        <div className="header-left">
          <h1>Обчислення факторіалів</h1>
          <div className={`balancer-status ${balancerStatus.status}`}>
            {balancerStatus.message}
          </div>
        </div>
        <div className="header-right">
          <div className="user-info">
            <span className="user-name">{user.username}</span>
            <button onClick={onLogout} className="logout-btn">
              Вийти
            </button>
          </div>
        </div>
      </header>

      <main className="home-main">
        <div className="input-section">
          <div className="input-group">
            <input
              type="number"
              value={number}
              onChange={e => setNumber(e.target.value)}
              placeholder="Введіть число (0–170)"
              min="0"
              max="170"
              onKeyPress={e => e.key === 'Enter' && startTask()}
              disabled={balancerStatus.status !== 'online' || loading}
              className="number-input"
            />
            <button
              onClick={startTask}
              disabled={loading || balancerStatus.status !== 'online'}
              className="start-btn"
            >
              {loading ? 'Запуск...' : 'Обчислити'}
            </button>
          </div>

          <div className="action-buttons">
            <button
              onClick={fetchHistory}
              disabled={balancerStatus.status !== 'online'}
              className="history-btn"
            >
              Історія
            </button>
            <button
              onClick={() => setHistory([])}
              className="clear-btn"
            >
              Закрити історію
            </button>
          </div>
        </div>

        {error && (
          <div className="error-message">{error}</div>
        )}

        <div className="tasks-section">
          <h2>Активні задачі ({tasks.length})</h2>

          {tasks.length === 0 ? (
            <div className="empty-state">
              {balancerStatus.status === 'online'
                ? 'Немає активних задач. Додайте нову.'
                : 'Система недоступна. Очікуйте відновлення роботи.'}
            </div>
          ) : (
            <div className="tasks-grid">
              {tasks.map(task => (
                <div key={task.taskId} className="task-card">
                  <div className="task-header">
                    <div className="task-title">
                      <h3>Обчислення {task.number}!</h3>
                      <span className="task-id">
                        ID: {task.taskId.slice(-8)}
                      </span>
                    </div>
                    <div
                      className="task-status"
                      style={{ color: getStatusColor(task.status) }}
                    >
                      {renderTaskStatus(task)}
                    </div>
                  </div>

                  <div className="task-info">
                    <div className="info-row">
                      <span className="info-label">Сервер:</span>
                      <span className="info-value">{task.server}</span>
                    </div>
                    <div className="info-row">
                      <span className="info-label">Тип:</span>
                      <span className="info-value">
                        {task.type === 'single'
                          ? 'Один сервер'
                          : task.type === 'distributed'
                          ? 'Розподілено'
                          : task.type}
                      </span>
                    </div>
                    <div className="info-row">
                      <span className="info-label">Прогрес:</span>
                      <span className="info-value">{task.progress.toFixed(1)}%</span>
                    </div>
                    {task.message && (
                      <div className="info-row">
                        <span className="info-label">Статус:</span>
                        <span className="info-value message">{task.message}</span>
                      </div>
                    )}
                  </div>

                  {renderProgress(task)}

                  {task.progress === 100 &&
                    task.result &&
                    task.result !== '1' &&
                    task.status === 'completed' && (
                      <div className="result-section">
                        <h4>Результат:</h4>
                        <div className="result-value">{formatLargeNumber(task.result)}</div>
                        <div className="result-length">Довжина: {task.result.length} цифр</div>
                      </div>
                    )}

                  <div className="task-actions">
                    {(task.status === 'started' ||
                      task.status === 'queued' ||
                      task.status === 'distributed') && (
                      <button
                        onClick={() => cancelTask(task.taskId)}
                        className="cancel-btn"
                      >
                        Скасувати
                      </button>
                    )}
                    <div className="task-time">
                      Створено: {new Date(task.createdAt).toLocaleTimeString('uk-UA')}
                    </div>
                    {task.completedAt && (
                      <div className="task-time">
                        Завершено: {new Date(task.completedAt).toLocaleTimeString('uk-UA')}
                      </div>
                    )}
                  </div>

                  {task.steps && task.steps.length > 0 && (
                    <details className="steps-details">
                      <summary>Кроки виконання ({task.steps.length})</summary>
                      <div className="steps-table">
                        <table>
                          <thead>
                            <tr>
                              <th>Сервер</th>
                              <th>Крок</th>
                              <th>Результат</th>
                            </tr>
                          </thead>
                          <tbody>
                            {task.steps
                              .slice()
                              .reverse()
                              .map((step, i) => (
                                <tr key={i}>
                                  <td>{step.server}</td>
                                  <td>{step.step}</td>
                                  <td className="step-result">{formatLargeNumber(step.result)}</td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {history.length > 0 && (
          <div className="history-section">
            <div className="history-header">
              <h2>Історія задач ({history.length})</h2>
            </div>

            <div className="history-table">
              <table>
                <thead>
                  <tr>
                    <th>Число</th>
                    <th>Результат</th>
                    <th>Тип</th>
                    <th>Сервер</th>
                    <th>Статус</th>
                    <th>Дата</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, index) => (
                    <tr key={h._id || index}>
                      <td>
                        <div className="history-number">{h.number}!</div>
                      </td>
                      <td className="history-result">{formatLargeNumber(h.result)}</td>
                      <td>
                        <div className={`history-type ${h.type}`}>
                          {h.type === 'single'
                            ? 'Один сервер'
                            : h.type === 'distributed'
                            ? 'Розподілено'
                            : h.type === 'part'
                            ? 'Частина'
                            : h.type}
                        </div>
                      </td>
                      <td>
                        <div className="history-server">{h.server}</div>
                      </td>
                      <td>
                        <div
                          className={`history-status ${h.status || 'completed'}`}
                          style={{ color: getStatusColor(h.status || 'completed') }}
                        >
                          {h.status === 'completed'
                            ? 'Завершено'
                            : h.status === 'failed'
                            ? 'Помилка'
                            : h.status === 'cancelled'
                            ? 'Скасовано'
                            : 'Завершено'}
                        </div>
                      </td>
                      <td className="history-date">
                        {h.createdAt ? new Date(h.createdAt).toLocaleString('uk-UA') : 'Невідомо'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

export default HomePage
