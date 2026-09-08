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

// server.js: use plain age instead of parsing birthdate
applyPatch(path.join(__dirname, 'server.js'), [
  [
`function getAgeFromBirthdate(dob) {
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
  if (!gender || !age || !height || !weight || !lifestyle || !goal) {`,
`function computeCalorieNorm(user) {
  const { gender, birthdate, height, weight, lifestyle, goal } = user;
  const age = parseInt(birthdate, 10) || null;
  if (!gender || !age || !height || !weight || !lifestyle || !goal) {`
  ]
]);

// index.html: birthdate section becomes age section
applyPatch(path.join(__dirname, 'static/index.html'), [
  [
`    <section v-if="page == 'birthdate'">
      <p>Введи дату рождения (ДД.ММ.ГГГГ) — нужно для расчёта нормы калорий:</p>
      <div class="buttons">
        <input type="text" v-model="editedValue" placeholder="01.01.1990"/>
      </div>
    </section>`,
`    <section v-if="page == 'birthdate'">
      <p>Сколько тебе лет? Нужно для расчёта нормы калорий:</p>
      <div class="buttons">
        <input type="number" v-model="editedValue" placeholder="30"/>
      </div>
    </section>`
  ]
]);

console.log('Done. Now: rm -f db.sqlite3 && pm2 restart guidefit-app');
