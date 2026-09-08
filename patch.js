const fs = require('fs');
const path = require('path');

function applyPatch(file, edits) {
  let content = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const [oldStr, newStr] of edits) {
    if (content.indexOf(oldStr) === -1) {
      throw new Error(`Pattern not found in ${file}:\n---\n${oldStr}\n---`);
    }
    content = content.split(oldStr).join(newStr);
  }
  fs.writeFileSync(file, content, 'utf8');
  console.log(`Patched ${file}`);
}

// ---------- storage.js: add lifestyle/goal/calorie_norm columns ----------
applyPatch(path.join(__dirname, 'storage.js'), [
  [
    `          weight: 'INT',\n          last_seen:`,
    `          weight: 'INT',\n          lifestyle: 'TEXT',\n          goal: 'TEXT',\n          calorie_norm: 'INT',\n          last_seen:`
  ]
]);

// ---------- server.js: calorie calc + /meal endpoint ----------
applyPatch(path.join(__dirname, 'server.js'), [
  [
`const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

function validateInitData(initData) {`,
`const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

let recipes = [];
try {
  recipes = JSON.parse(fs.readFileSync(path.join(__dirname, 'recipes.json'), 'utf8'));
} catch (e) {
  console.error('Could not load recipes.json:', e.message);
}

const ACTIVITY_MULTIPLIERS = { 1: 1.2, 2: 1.375, 3: 1.55, 4: 1.725 };

function getAgeFromBirthdate(dob) {
  if (!dob) return null;
  const parts = dob.split('.').map(v => parseInt(v, 10));
  const [day, month, year] = parts;
  if (!day || !month || !year) return null;
  const now = new Date();
  let age = now.getFullYear() - year;
  if (now.getMonth() + 1 < month || (now.getMonth() + 1 == month && now.getDate() < day)) {
    age--;
  }
  return age;
}

function computeCalorieNorm(user) {
  const { gender, birthdate, height, weight, lifestyle, goal } = user;
  const age = getAgeFromBirthdate(birthdate);
  if (!gender || !age || !height || !weight || !lifestyle || !goal) {
    return null;
  }
  const w = parseFloat(weight);
  const h = parseFloat(height);
  const bmr = 10 * w + 6.25 * h - 5 * age + (gender == 2 ? -161 : 5);
  const tdee = bmr * (ACTIVITY_MULTIPLIERS[lifestyle] || 1.2);
  let norm = tdee;
  if (goal == 'cut') norm = tdee - 500;
  else if (goal == 'bulk') norm = tdee + 300;
  return Math.round(norm);
}

function validateInitData(initData) {`
  ],
  [
    `if (!['name', 'interests', 'about', 'hide_profile', 'lang', 'gender', 'display_gender', 'pronouns', 'sexuality', 'lookingfor', 'birthdate', 'city', 'geo', 'height', 'weight', 'onboarding_step', 'profile_step'].includes(key)) {`,
    `if (!['name', 'interests', 'about', 'hide_profile', 'lang', 'gender', 'display_gender', 'pronouns', 'sexuality', 'lookingfor', 'birthdate', 'city', 'geo', 'height', 'weight', 'lifestyle', 'goal', 'onboarding_step', 'profile_step'].includes(key)) {`
  ],
  [
`  await db.updateUserByTgId(initData.user.id, fields);
  res.json({ ok: true });
});`,
`  await db.updateUserByTgId(initData.user.id, fields);
  const updatedMe = await db.userByTgId(initData.user.id);
  const calorieNorm = computeCalorieNorm(updatedMe);
  if (calorieNorm && updatedMe.calorie_norm !== calorieNorm) {
    await db.updateUserByTgId(initData.user.id, { calorie_norm: calorieNorm });
  }
  res.json({ ok: true, calorie_norm: calorieNorm });
});`
  ],
  [
`app.listen(process.env.MINIAPP_PORT, () => {`,
`app.post('/meal', async (req, res) => {
  const initData = validateInitData(req.body.initData);
  if (!initData) {
    res.json({ error: 'Invalid initData' });
    return;
  }
  const me = await db.userByTgId(initData.user.id);
  const category = req.body.category;
  let pool = recipes.filter(r => r.category === category);
  const byGoal = pool.filter(r => !r.goals || r.goals.includes(me.goal));
  if (byGoal.length) {
    pool = byGoal;
  }
  if (!pool.length) {
    res.json({ error: 'No recipes found for this category' });
    return;
  }
  const recipe = pool[Math.floor(Math.random() * pool.length)];
  res.json({ recipe });
});

app.listen(process.env.MINIAPP_PORT, () => {`
  ]
]);

// ---------- static/js/app.js: onboarding + meal flow ----------
applyPatch(path.join(__dirname, 'static/js/app.js'), [
  [
`const ProfileFields = [
  ['name', 10],
  ['birthdate', 20],
  ['interests', 30],
  ['city', 40],
//  ['display_gender', 50],
  ['pronouns', 60],
  ['sexuality', 70],
  ['height', 80],
  ['weight', 90],
  ['about', 120]
];`,
`const ProfileFields = [
  ['birthdate', 100],
  ['height', 110],
  ['weight', 120]
];`
  ],
  [
`      if (newPage == 'lookingfor') {
        Telegram.WebApp.MainButton.hide();
      } else`,
`      if (newPage == 'lifestyle') {
        Telegram.WebApp.MainButton.hide();
      } else
      if (newPage == 'goal') {
        Telegram.WebApp.MainButton.hide();
      } else`
  ],
  [
`    async selectGender(gender) {
      if (this.me.onboarding_step < 60) {
        await this.update({ onboarding_step: 60, gender });
        this.turnPage('lookingfor');
      } else {
        await this.update({ gender });
        this.popPage();
      }
    },
    async selectLookingFor(lookingfor) {
      if (this.me.onboarding_step < 110) {
        await this.update({ onboarding_step: 110, lookingfor });
        this.turnPage('photo');
      } else {
        await this.update({ lookingfor });
        this.popPage();
      }
    },`,
`    async selectGender(gender) {
      if (this.me.onboarding_step < 60) {
        await this.update({ onboarding_step: 60, gender });
        this.turnPage('lifestyle');
      } else {
        await this.update({ gender });
        this.popPage();
      }
    },
    async selectLifestyle(lifestyle) {
      if (this.me.onboarding_step < 90) {
        await this.update({ onboarding_step: 90, lifestyle });
        this.turnPage('birthdate');
      } else {
        await this.update({ lifestyle });
        this.popPage();
      }
    },
    async selectGoal(goal) {
      if (this.me.onboarding_step < 130) {
        await this.update({ onboarding_step: 130, goal });
        this.turnPage('home');
      } else {
        await this.update({ goal });
        this.popPage();
      }
    },`
  ],
  [
`    async onMainButton() {
      if (this.page == 'agreement') {
        this.onboardingPage('gender', 10, true);
      } else
      if (this.page == 'gender') {
        this.onboardingPage('lookingfor', 60);
      } else
      if (this.page == 'lookingfor') {
        this.onboardingPage('home', 120);
      }
      for (let i = 0; i < ProfileFields.length; i++) {
        const [name, step] = ProfileFields[i];
        if (this.page == name) {
          await this.update({ [name]: this.editedValue });
          if (this.me.profile_step < 120) {
            this.profilePage(i < ProfileFields.length - 1 ? ProfileFields[i + 1][0] : 'home', step);
          } else {
            this.popPage();
          }
        }
      }
    },`,
`    async onMainButton() {
      if (this.page == 'agreement') {
        this.onboardingPage('gender', 10, true);
      } else
      if (this.page == 'birthdate') {
        await this.update({ birthdate: this.editedValue });
        if (this.me.onboarding_step < 100) {
          this.onboardingPage('height', 100);
        } else {
          this.popPage();
        }
      } else
      if (this.page == 'height') {
        await this.update({ height: this.editedValue });
        if (this.me.onboarding_step < 110) {
          this.onboardingPage('weight', 110);
        } else {
          this.popPage();
        }
      } else
      if (this.page == 'weight') {
        await this.update({ weight: this.editedValue });
        if (this.me.onboarding_step < 120) {
          this.onboardingPage('goal', 120);
        } else {
          this.popPage();
        }
      }
    },`
  ],
  [
`    async search(isLocal) {
      this.isLocalSearch = isLocal;

      if (isLocal) {
        navigator.geolocation.getCurrentPosition(async (pos) => {
          this.feed = (await this.api('search', { local: true, latitude: pos.coords.latitude, longitude: pos.coords.longitude })).feed;
          this.turnPage('search');
        }, (err) => {
          //
        });
      } else {
        this.feed = (await this.api('search', { local: false })).feed;
        this.turnPage('search');
      }
    },
    async like(user, likeType) {
      for (let i = 0; i < this.feed.length; i++) {
        if (this.feed[i].id == user.id) {
          this.feed.splice(i, 1);
          break;
        }
      }
      const result = await this.api('like', { id: user.id, type: likeType });
      if (result.mutual) {
        this.notifications.push({
          user: result.mutual,
        });

        setTimeout(() => {
          this.notifications = this.notifications.filter(notif => notif.user.id != result.mutual.id);
        }, 5000);
      }
    },`,
`    async getMeal(category) {
      this.currentCategory = category;
      this.showSteps = false;
      const result = await this.api('meal', { category });
      this.currentRecipe = result.recipe || null;
      this.turnPage('meal');
    },
    async anotherMeal() {
      this.showSteps = false;
      const result = await this.api('meal', { category: this.currentCategory });
      this.currentRecipe = result.recipe || null;
    },
    cookMeal() {
      this.showSteps = true;
    },`
  ],
  [
`    if (this.me.onboarding_step < 10) {
      this.turnPage('agreement', true);
    } else
    if (this.me.onboarding_step < 60) {
      this.turnPage('gender', true);
    } else
    if (this.me.onboarding_step < 110) {
      this.turnPage('lookingfor', true);
    } else 
    if (this.me.onboarding_step < 120) {
      this.turnPage('photo', true);
    } else {
      this.turnPage('home', true);
    }`,
`    if (this.me.onboarding_step < 10) {
      this.turnPage('agreement', true);
    } else
    if (this.me.onboarding_step < 60) {
      this.turnPage('gender', true);
    } else
    if (this.me.onboarding_step < 90) {
      this.turnPage('lifestyle', true);
    } else
    if (this.me.onboarding_step < 100) {
      this.turnPage('birthdate', true);
    } else
    if (this.me.onboarding_step < 110) {
      this.turnPage('height', true);
    } else
    if (this.me.onboarding_step < 120) {
      this.turnPage('weight', true);
    } else
    if (this.me.onboarding_step < 130) {
      this.turnPage('goal', true);
    } else {
      this.turnPage('home', true);
    }`
  ],
  [
`    feed: [],
    notifications: [],`,
`    feed: [],
    notifications: [],

    currentCategory: null,
    currentRecipe: null,
    showSteps: false,`
  ]
]);

// ---------- static/index.html: onboarding + home + meal screens ----------
applyPatch(path.join(__dirname, 'static/index.html'), [
  [
`    <section v-if="page == 'gender'">
      <p v-html="$str.msg_gender.replaceAll(/\\n/g, '<br/>')"></p>
      <label><input type="checkbox" v-model="isCouple"/> {{ $str.gender_couple }}</label>
      <div class="buttons">
        <button v-for="genderId in [1, 2, 3, 4, 5]" @click="selectGender(genderId)">{{ $str['gender:' + genderId] }}</button>
        <div class="link-button" v-if="me.onboarding_step < 120" @click="onboardingPage('lookingfor', 60)">{{ $str.btn_skip }}</div>
      </div>
    </section>`,
`    <section v-if="page == 'gender'">
      <p>Для точного расчёта нормы калорий укажи пол:</p>
      <div class="buttons">
        <button @click="selectGender(1)">Мужчина</button>
        <button @click="selectGender(2)">Женщина</button>
      </div>
    </section>`
  ],
  [
`    <section v-if="page == 'lookingfor'">
      <p v-html="$str.msg_lookingfor.replaceAll(/\\n/g, '<br/>')"></p>
      <div class="buttons">
        <button v-for="lookingForId in [1, 2, 3, 4, 5, 6]" @click="selectLookingFor(lookingForId)">{{ $str['lookingfor:' + lookingForId] }}</button>
        <div class="link-button" v-if="me.onboarding_step < 120" @click="onboardingPage('photo', 110)">{{ $str.btn_skip }}</div>
      </div>
    </section>`,
`    <section v-if="page == 'lifestyle'">
      <p>Какой у тебя уровень активности?</p>
      <div class="buttons">
        <button @click="selectLifestyle(1)">Малоподвижный (сидячая работа)</button>
        <button @click="selectLifestyle(2)">Лёгкая активность (1-3 тренировки/нед)</button>
        <button @click="selectLifestyle(3)">Средняя активность (3-5 тренировок/нед)</button>
        <button @click="selectLifestyle(4)">Высокая активность (спорт каждый день)</button>
      </div>
    </section>
    <section v-if="page == 'goal'">
      <p>Какая у тебя цель?</p>
      <div class="buttons">
        <button @click="selectGoal('cut')">Похудеть</button>
        <button @click="selectGoal('bulk')">Набрать массу</button>
        <button @click="selectGoal('recomp')">Рекомпозиция (сушка + масса)</button>
      </div>
    </section>`
  ],
  [
`    <section v-if="page == 'birthdate'">
      <p v-html="$str.msg_profile_birthdate.replaceAll(/\\n/g, '<br/>')"></p>
      <div class="buttons">
        <input type="text" v-model="editedValue"/>
        <div class="link-button" v-if="me.profile_step < 120" @click="profilePage('interests', 20)">{{ $str.btn_skip }}</div>
      </div>
    </section>`,
`    <section v-if="page == 'birthdate'">
      <p>Введи дату рождения (ДД.ММ.ГГГГ) — нужно для расчёта нормы калорий:</p>
      <div class="buttons">
        <input type="text" v-model="editedValue" placeholder="01.01.1990"/>
      </div>
    </section>`
  ],
  [
`    <section v-if="page == 'height'">
      <p v-html="$str.msg_profile_height.replaceAll(/\\n/g, '<br/>')"></p>
      <div class="buttons">
        <input type="text" v-model="editedValue"/>
        <div class="link-button" v-if="me.profile_step < 120" @click="profilePage('weight', 80)">{{ $str.btn_skip }}</div>
      </div>
    </section>`,
`    <section v-if="page == 'height'">
      <p>Введи рост в сантиметрах:</p>
      <div class="buttons">
        <input type="text" v-model="editedValue" placeholder="175"/>
      </div>
    </section>`
  ],
  [
`    <section v-if="page == 'weight'">
      <p v-html="$str.msg_profile_weight.replaceAll(/\\n/g, '<br/>')"></p>
      <div class="buttons">
        <input type="text" v-model="editedValue"/>
        <div class="link-button" v-if="me.profile_step < 120" @click="profilePage('about', 90)">{{ $str.btn_skip }}</div>
      </div>
    </section>`,
`    <section v-if="page == 'weight'">
      <p>Введи вес в килограммах:</p>
      <div class="buttons">
        <input type="text" v-model="editedValue" placeholder="70"/>
      </div>
    </section>`
  ],
  [
`    <section v-if="page == 'home'">
      <p v-html="(me.profile_step < 120 ? $str.msg_onboarding_done : $str.msg_main_short).replaceAll(/\\n/g, '<br/>')"></p>
      <div class="buttons">
        <button @click="search(true)">{{ $str.btn_local }}</button>
        <button @click="search(false)">{{ $str.btn_global }}</button>
        <button @click="editProfile()">{{ me.profile_step < 120 ? $str.btn_fillprofile : $str.btn_editprofile }}</button>
        <button @click="showMatches()">{{ $str.btn_matches }}</button>
        <button @click="turnPage('settings')">{{ $str.btn_settings }}</button>
      </div>
    </section>`,
`    <section v-if="page == 'home'">
      <p>Твоя дневная норма: <b>{{ me.calorie_norm || '—' }} ккал</b></p>
      <div class="buttons">
        <button @click="getMeal('breakfast')">Завтрак</button>
        <button @click="getMeal('lunch')">Обед</button>
        <button @click="getMeal('dinner')">Ужин</button>
        <button @click="getMeal('snack')">Перекус</button>
        <button @click="turnPage('settings')">{{ $str.btn_settings }}</button>
      </div>
    </section>
    <section v-if="page == 'meal'">
      <div v-if="currentRecipe">
        <h3>{{ currentRecipe.name }}</h3>
        <p>{{ currentRecipe.calories }} ккал &middot; Б{{ currentRecipe.protein }} Ж{{ currentRecipe.fat }} У{{ currentRecipe.carbs }}</p>
        <ol v-if="showSteps">
          <li v-for="step in currentRecipe.steps">{{ step }}</li>
        </ol>
        <div class="buttons" v-if="!showSteps">
          <button @click="cookMeal()">Готовить</button>
          <button @click="anotherMeal()">Другое блюдо</button>
        </div>
      </div>
      <div v-else>Рецепты для этой категории пока не загружены.</div>
    </section>`
  ],
  [
`    <section v-if="page == 'settings'">
      <div class="buttons">
        <button @click="turnPage('lookingfor')">{{ $str.btn_filter_genders }}</button>
        <button @click="toggleHidden()">{{ $str[this.me.hide_profile ? 'btn_hide:1' : 'btn_hide:0'] }}</button>
        <button @click="turnPage('language')">{{ $str.btn_langs }}</button>
        <button @click="deleteAccount()">{{ $str.btn_delete_account }}</button>
      </div>
    </section>`,
`    <section v-if="page == 'settings'">
      <div class="buttons">
        <button @click="turnPage('language')">{{ $str.btn_langs }}</button>
        <button @click="deleteAccount()">{{ $str.btn_delete_account }}</button>
      </div>
    </section>`
  ]
]);

// ---------- recipes.json: starter pool ----------
fs.writeFileSync(path.join(__dirname, 'recipes.json'), JSON.stringify([
  { category: "breakfast", goals: ["cut","recomp"], name: "Овсянка с ягодами", calories: 320, protein: 15, fat: 8, carbs: 45, steps: ["Залей 60г овсянки 200мл кипятка или молока", "Дай настояться 5 минут", "Добавь горсть ягод и 1 ч.л. мёда"] },
  { category: "breakfast", goals: ["bulk","recomp"], name: "Омлет из 3 яиц с сыром", calories: 420, protein: 28, fat: 30, carbs: 4, steps: ["Взбей 3 яйца с щепоткой соли", "Вылей на разогретую сковороду с маслом", "За минуту до готовности добавь тёртый сыр"] },
  { category: "breakfast", goals: ["cut"], name: "Творог с бананом", calories: 280, protein: 25, fat: 5, carbs: 30, steps: ["Смешай 200г творога 5% с половиной банана", "По желанию добавь корицу"] },
  { category: "lunch", goals: ["cut","recomp"], name: "Куриная грудка с гречкой и овощами", calories: 480, protein: 40, fat: 10, carbs: 50, steps: ["Отвари 80г гречки", "Обжарь 150г куриной грудки на гриле", "Подавай с овощным салатом"] },
  { category: "lunch", goals: ["bulk"], name: "Паста с говядиной", calories: 650, protein: 35, fat: 20, carbs: 70, steps: ["Отвари 100г пасты", "Обжарь 150г говяжьего фарша с луком", "Смешай с томатным соусом и пастой"] },
  { category: "lunch", goals: ["cut","bulk","recomp"], name: "Суп с чечевицей", calories: 350, protein: 20, fat: 8, carbs: 45, steps: ["Отвари 100г чечевицы с овощами 25 минут", "Приправь по вкусу"] },
  { category: "dinner", goals: ["cut"], name: "Рыба на пару с брокколи", calories: 320, protein: 35, fat: 8, carbs: 15, steps: ["Приготовь 150г белой рыбы на пару 15 минут", "Отвари брокколи 5 минут", "Подавай с лимоном"] },
  { category: "dinner", goals: ["bulk","recomp"], name: "Стейк с картофелем", calories: 600, protein: 40, fat: 25, carbs: 45, steps: ["Обжарь 180г стейка по 4 минуты с каждой стороны", "Запеки картофель 20 минут", "Дай стейку отдохнуть 5 минут"] },
  { category: "dinner", goals: ["cut","recomp"], name: "Тушёная индейка с овощами", calories: 380, protein: 38, fat: 10, carbs: 20, steps: ["Обжарь 150г индейки", "Добавь нарезанные овощи и тушите 15 минут"] },
  { category: "snack", goals: ["cut"], name: "Яблоко с миндалём", calories: 180, protein: 5, fat: 10, carbs: 20, steps: ["Нарежь яблоко дольками", "Съешь с горстью миндаля (15г)"] },
  { category: "snack", goals: ["bulk","recomp"], name: "Протеиновый коктейль с бананом", calories: 320, protein: 30, fat: 5, carbs: 35, steps: ["Смешай в блендере 1 мерную ложку протеина, банан и 250мл молока"] },
  { category: "snack", goals: ["cut","bulk","recomp"], name: "Греческий йогурт с орехами", calories: 220, protein: 15, fat: 12, carbs: 12, steps: ["Смешай 150г греческого йогурта с 20г орехов"] }
], null, 2), 'utf8');
console.log('Created recipes.json');
