// worker.js - РОБОЧА ВЕРСІЯ
const { parentPort, workerData } = require('worker_threads');

// workerData містить параметри, передані з головного потоку
const { taskId, start, end, initialValue, serverName, isPart } = workerData;

console.log(`[Worker ${taskId}] 🚀 ЗАПУСК з ${start} до ${end}`);

let current = BigInt(start);
const bigEnd = BigInt(end);
let accumulation = BigInt(initialValue || 1);

const totalSteps = Number(bigEnd - current + 1n);
let stepsDone = 0;

// Асинхронна функція для затримки
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ФІКСОВАНА ТРИВАЛІСТЬ - 120 секунд
const FIXED_DURATION_SECONDS = 120;

async function calculate() {
    const startTime = Date.now();
    
    console.log(`[Worker ${taskId}] ⏱️  Початок обчислення на ${FIXED_DURATION_SECONDS} секунд`);
    
    // 1. НЕГАЙНО надсилаємо перший прогрес (0%)
    parentPort.postMessage({
        type: 'progress',
        taskId,
        currentValue: accumulation.toString(),
        progress: 0,
        stepInfo: `Початок обчислення ${start}-${end}`
    });
    
    // 2. Затримка 1 секунда для демонстрації
    await sleep(1000);
    
    // 3. Оновлюємо прогрес (10%)
    parentPort.postMessage({
        type: 'progress',
        taskId,
        currentValue: accumulation.toString(),
        progress: 10,
        stepInfo: `Ініціалізація завершена`
    });
    
    // 4. Розраховуємо затримку на кожен крок
    let delayPerStep = 0;
    if (totalSteps > 0) {
        // Залишаємо 2 секунди на швидке обчислення, решта - затримки
        const computeTime = 2000; // 2 секунди на обчислення
        const delayTime = (FIXED_DURATION_SECONDS * 1000) - computeTime - 1000; // Мінус вже витрачений час
        delayPerStep = Math.max(100, delayTime / totalSteps); // Мінімум 100мс
    }
    
    console.log(`[Worker ${taskId}] 📊 Затримка на крок: ${delayPerStep.toFixed(0)}мс`);
    
    // 5. Основний цикл
    while (current <= bigEnd) {
        // Обчислення
        accumulation *= current;
        stepsDone++;
        
        // Оновлюємо прогрес кожні 25% або на останньому кроці
        if (stepsDone === 1 || stepsDone % Math.max(1, Math.floor(totalSteps / 4)) === 0 || current === bigEnd) {
            const progress = Math.min(100, 10 + (stepsDone / totalSteps) * 85);
            const elapsedSeconds = (Date.now() - startTime) / 1000;
            
            console.log(`[Worker ${taskId}] 📤 Відправляю прогрес: ${progress.toFixed(1)}% (крок ${current})`);
            
            parentPort.postMessage({
                type: 'progress',
                taskId,
                currentValue: accumulation.toString(),
                progress: progress,
                stepInfo: `${current}! (${elapsedSeconds.toFixed(1)}с)`
            });
        }
        
        // Затримка для контролю тривалості
        if (delayPerStep > 0) {
            await sleep(delayPerStep);
        }
        
        // Даємо event loop "дихати"
        if (stepsDone % 50 === 0) {
            await new Promise(resolve => setImmediate(resolve));
        }
        
        current++;
    }
    
    // 6. Оновлюємо прогрес до 100%
    const totalTime = (Date.now() - startTime) / 1000;
    
    console.log(`[Worker ${taskId}] 🎉 ЗАВЕРШЕНО за ${totalTime.toFixed(1)} секунд`);
    
    parentPort.postMessage({
        type: 'progress',
        taskId,
        currentValue: accumulation.toString(),
        progress: 99,
        stepInfo: `Фіналізація...`
    });
    
    await sleep(500);
    
    parentPort.postMessage({
        type: 'done',
        taskId,
        result: accumulation.toString(),
        totalTime: totalTime
    });
}

// Обробка помилок
calculate().catch(error => {
    console.error(`[Worker ${taskId}] ❌ ПОМИЛКА:`, error);
    
    parentPort.postMessage({
        type: 'error',
        taskId,
        error: error.message
    });
});