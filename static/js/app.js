const app = {
    user: { tg_id: 1 },
    content: document.getElementById('content'),
    navButtons: document.querySelectorAll('#bottom-nav button'),

    async api(endpoint, params = {}) {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...params, tg_id: this.user.tg_id })
        });
        return await response.json();
    },

    // Page transition with spring-like effect
    render(html) {
        this.content.style.opacity = 0;
        this.content.style.transform = 'translateY(10px)';
        
        setTimeout(() => {
            this.content.innerHTML = html;
            this.content.style.opacity = 1;
            this.content.style.transform = 'translateY(0)';
        }, 150);
    },

    async showHome() {
        const stats = await this.api('/api/dashboard');
        this.render(`
            <h2>Добро пожаловать</h2>
            <div class="card">
                <div style="color:var(--text-muted); font-size: 0.9rem;">Твоя цель</div>
                <div style="font-size: 2.5rem; font-weight: 700; margin-top:4px;">
                    ${stats.norms.calories} 
                    <span style="font-size: 1rem; color:var(--text-muted)">ккал</span>
                </div>
            </div>
            <div class="grid">
                <div class="card">🔥 <br/><span style="font-size: 1.5rem; font-weight: 700;">${stats.streak}</span><br/> дней</div>
                <div class="card">💧 <br/><span style="font-size: 1.5rem; font-weight: 700;">1.5</span><br/> литра</div>
            </div>
        `);
    },

    async showMeals() {
        this.render(`
            <h2>Питание</h2>
            <button class="btn" style="margin-bottom: 16px" data-category="breakfast">Завтрак</button>
            <button class="btn" style="margin-bottom: 16px" data-category="lunch">Обед</button>
            <button class="btn" style="margin-bottom: 16px" data-category="dinner">Ужин</button>
        `);
    },

    async showStats() {
        this.render(`
            <h2>Прогресс</h2>
            <div class="card">
                <canvas id="calorieChart"></canvas>
            </div>
        `);
        this.renderChart();
    },

    renderChart() {
        const ctx = document.getElementById('calorieChart').getContext('2d');
        new Chart(ctx, {
            type: 'line',
            data: {
                labels: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
                datasets: [{
                    data: [1800, 1950, 1700, 2000, 1850, 2100, 1900],
                    borderColor: '#ffffff',
                    borderWidth: 3,
                    tension: 0.4
                }]
            },
            options: { 
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#94a3b8' } },
                    y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8' } }
                }
            }
        });
    },

    init() {
        // Set initial transition styles
        this.content.style.transition = 'var(--spring)';
        
        document.body.addEventListener('click', (e) => {
            const page = e.target.dataset.page;
            if (page) {
                this.navButtons.forEach(b => b.classList.toggle('active', b.dataset.page === page));
                if (page === 'home') this.showHome();
                if (page === 'meals') this.showMeals();
                if (page === 'stats') this.showStats();
            }
        });
        this.showHome();
    }
};
app.init();
