// The Bankroll Challenge's generic players' faces and names (#305), drawn
// on the page from a seed with ducy's avatar code (avatar-draw.js), so there
// are thousands of different people, not a fixed set of pictures.
//
// - **Bases:** 64 people set by hand: gender, age band, skin, face shape,
//   natural hair colour, and the name pool (the background their names come
//   from), chosen by hand for each base and never worked out from looks.
// - **Variants:** each person adds to their base a hairstyle for their gender
//   and age, a hair colour (greying with age, now and then dyed when young),
//   facial hair, clothes and colours, sometimes glasses, an expression and a
//   background, all from their seed.
// - **Gear,** a clue to style (#306), as a lean: headphones, a hoodie or
//   sunglasses lean grinder; a cap, a beanie or a tourist shirt lean loose;
//   a sports jacket leans rock. Older players lean rock.
// - **Names:** a first name from the base's pool, gender and age band (names
//   common for that generation), and a last initial. Invented-for-the-table
//   common names only, no famous people.
//
// Pure and the same for the same seed: a bot id always shows the same person.

import { seatAvatar } from './avatar-draw.js';
import { roll } from './quest-rooms.js';

// Natural hair colours.
const H = {blonde: '#d9b26b', light: '#8a5a36', brown: '#4a3324', dark: '#1d1410', black: '#121212', red: '#a8452a', auburn: '#7a3a22'};

// The bases: [pool, gender, age, skin, face, hair colour, fixed headwear].
const BASE_ROWS = [
  ['english', 'f', 'young', 's1', 'oval', H.blonde],
  ['english', 'm', 'middle', 's2', 'square', H.brown],
  ['english', 'f', 'older', 's1', 'round', H.light],
  ['english', 'm', 'young', 's2', 'long', H.red],
  ['black', 'm', 'young', 's5', 'oval', H.black],
  ['black', 'f', 'middle', 's6', 'heart', H.black],
  ['black', 'm', 'older', 's5', 'wide', H.black],
  ['english', 'f', 'young', 's4', 'oval', H.dark],
  ['irish', 'f', 'young', 's1', 'heart', H.red],
  ['irish', 'm', 'middle', 's1', 'wide', H.auburn],
  ['irish', 'm', 'older', 's2', 'long', H.light],
  ['irish', 'f', 'middle', 's1', 'oval', H.auburn],
  ['hispanic', 'f', 'young', 's3', 'oval', H.dark],
  ['hispanic', 'm', 'young', 's3', 'oval', H.dark],
  ['hispanic', 'm', 'middle', 's4', 'round', H.dark],
  ['hispanic', 'f', 'older', 's3', 'round', H.dark],
  ['hispanic', 'f', 'middle', 's2', 'heart', H.brown],
  ['italian', 'm', 'middle', 's2', 'square', H.dark],
  ['italian', 'f', 'middle', 's2', 'oval', H.dark],
  ['italian', 'm', 'older', 's2', 'wide', H.dark],
  ['italian', 'f', 'young', 's2', 'long', H.brown],
  ['polish', 'f', 'young', 's1', 'oval', H.light],
  ['polish', 'm', 'middle', 's1', 'square', H.light],
  ['polish', 'f', 'older', 's1', 'round', H.brown],
  ['polish', 'm', 'young', 's1', 'oval', H.blonde],
  ['greek', 'm', 'young', 's2', 'oval', H.dark],
  ['greek', 'f', 'middle', 's3', 'long', H.dark],
  ['greek', 'm', 'older', 's3', 'heavy', H.dark],
  ['chinese', 'f', 'young', 'ea', 'oval', H.black],
  ['chinese', 'm', 'middle', 'ea', 'round', H.black],
  ['chinese', 'f', 'older', 'ea', 'round', H.black],
  ['chinese', 'm', 'young', 'ea', 'long', H.black],
  ['vietnamese', 'f', 'middle', 'ea', 'heart', H.black],
  ['vietnamese', 'm', 'young', 'ea', 'oval', H.black],
  ['vietnamese', 'm', 'older', 'ea', 'long', H.black],
  ['korean', 'f', 'young', 'ea', 'oval', H.black],
  ['korean', 'm', 'young', 'ea', 'square', H.black],
  ['korean', 'f', 'middle', 'ea', 'round', H.black],
  ['filipino', 'f', 'young', 's3', 'oval', H.black],
  ['filipino', 'm', 'middle', 's3', 'round', H.black],
  ['filipino', 'f', 'older', 's3', 'round', H.black],
  ['indian', 'f', 'young', 's4', 'oval', H.black],
  ['indian', 'm', 'middle', 's4', 'long', H.black],
  ['indian', 'f', 'middle', 's4', 'heart', H.black],
  ['indian', 'm', 'older', 's4', 'wide', H.black],
  ['arabic', 'm', 'young', 's3', 'oval', H.black],
  ['arabic', 'f', 'middle', 's3', 'oval', H.black, 'hijab'],
  ['arabic', 'm', 'older', 's3', 'long', H.black],
  ['arabic', 'f', 'young', 's2', 'heart', H.dark],
  ['persian', 'f', 'young', 's2', 'oval', H.dark],
  ['persian', 'm', 'middle', 's2', 'long', H.dark],
  ['persian', 'f', 'older', 's2', 'round', H.dark],
  ['nigerian', 'm', 'young', 's6', 'oval', H.black],
  ['nigerian', 'f', 'young', 's5', 'oval', H.black],
  ['nigerian', 'm', 'middle', 's5', 'round', H.black],
  ['nigerian', 'f', 'older', 's6', 'round', H.black],
  ['nigerian', 'f', 'middle', 's5', 'heart', H.black],
  ['japanese', 'f', 'young', 'ea', 'oval', H.black],
  ['japanese', 'm', 'middle', 'ea', 'long', H.black],
  ['japanese', 'm', 'older', 'ea', 'square', H.black],
  ['black', 'f', 'young', 's5', 'oval', H.black],
  ['black', 'm', 'middle', 's6', 'square', H.black],
  ['black', 'f', 'older', 's6', 'round', H.black],
  ['black', 'm', 'young', 's6', 'long', H.black],
];
export const BASES = BASE_ROWS.map(([pool, gender, age, skin, face, hairC, wear], i) => ({id: i, pool, gender, age, skin, face, hairC, wear: wear || ''}));

// First names by pool, gender and age band: names common for that
// generation, eight or more each.
const n = s => s.split(' ');
export const NAMES = {
  english: {
    f: {young: n('Emma Olivia Chloe Lily Grace Hannah Ava Zoe Maddie'), middle: n('Lisa Michelle Karen Amy Heather Julie Wendy Dana Tanya'), older: n('Dorothy Barbara Joan Shirley Betty Carol Judy Peggy Lois')},
    m: {young: n('Tyler Ethan Jake Ryan Owen Cody Dylan Noah Logan'), middle: n('Dave Mike Steve Rob Brian Greg Paul Jim Kevin'), older: n('Walt Harold Earl Stan Gene Herb Hank Norm Clyde')},
  },
  // African-American names, by generation.
  black: {
    f: {young: n('Aaliyah Jada Imani Destiny Kiara Jasmine Nia Tiana Brianna'), middle: n('Keisha Tamika Latoya Shanice Monique Ebony Tanisha Yolanda Kendra'), older: n('Gladys Bernice Mattie Odessa Hattie Ernestine Loretta Earline Mavis')},
    m: {young: n('DeShawn Jaylen Malik Darius Isaiah Terrell Xavier Andre Jalen'), middle: n('Darnell Jamal Tyrone Reggie Marcus Terrence Cedric Lamont Dwayne'), older: n('Otis Willie Leroy Clarence Roosevelt Booker Alonzo Cleveland Thaddeus')},
  },
  irish: {
    f: {young: n('Aoife Ciara Niamh Erin Saoirse Orla Caitlin Molly'), middle: n('Siobhan Maeve Sinead Fiona Colleen Bridget Nora Deirdre'), older: n('Maureen Eileen Kathleen Margaret Mary Agnes Bernadette Rosaleen')},
    m: {young: n('Liam Conor Sean Declan Cian Ronan Kieran Finn'), middle: n('Patrick Brendan Kevin Dermot Colm Niall Shane Brian'), older: n('Seamus Michael Thomas Francis Gerald Cornelius Desmond Eamon')},
  },
  hispanic: {
    f: {young: n('Sofia Valentina Camila Lucia Isabella Daniela Ximena Mariana'), middle: n('Carmen Gabriela Veronica Adriana Patricia Leticia Claudia Lorena'), older: n('Rosa Guadalupe Dolores Esperanza Consuelo Graciela Socorro Lourdes')},
    m: {young: n('Mateo Diego Santiago Luis Andres Javier Adrian Emilio'), middle: n('Carlos Hector Jorge Ricardo Manny Raul Miguel Roberto'), older: n('Jose Ramon Ernesto Arturo Rafael Alfonso Domingo Ignacio')},
  },
  italian: {
    f: {young: n('Giulia Chiara Alessia Francesca Sara Martina Giorgia Elena'), middle: n('Gina Tina Angela Teresa Daniela Paola Silvia Monica'), older: n('Rosa Carmela Concetta Giuseppina Antonietta Lucia Filomena Maria')},
    m: {young: n('Luca Matteo Marco Nico Alessandro Lorenzo Gianni Dario'), middle: n('Tony Sal Vinny Frank Paolo Enzo Joe Carlo'), older: n('Angelo Carmine Giuseppe Domenic Vito Aldo Rocco Silvio')},
  },
  polish: {
    f: {young: n('Zofia Natalia Kasia Ola Julia Wiktoria Maja Zuzanna'), middle: n('Agnieszka Magda Joanna Beata Ewa Dorota Marta Iwona'), older: n('Halina Krystyna Danuta Jadwiga Teresa Barbara Wanda Irena')},
    m: {young: n('Kuba Kacper Mateusz Szymon Bartek Filip Michal Wojtek'), middle: n('Tomasz Piotr Marek Pawel Krzysztof Darek Andrzej Grzegorz'), older: n('Stanislaw Zbigniew Henryk Tadeusz Jerzy Kazimierz Wladek Ryszard')},
  },
  greek: {
    f: {young: n('Eleni Sophia Katerina Maria Christina Ioanna Despina Zoe'), middle: n('Georgia Vasiliki Athena Dimitra Anna Niki Stella Irene'), older: n('Kalliope Panagiota Eftychia Fotini Antigone Chrysoula Evangelia Despo')},
    m: {young: n('Nikos Giorgos Dimitri Kostas Yannis Alexis Stavros Theo'), middle: n('Spiros Christos Vasilis Takis Petros Manolis Andreas Nick'), older: n('Konstantinos Panagiotis Evangelos Stelios Athanasios Gus Lefteris Aristotle')},
  },
  chinese: {
    f: {young: n('Mei Lin Xiaoyu Jing Ying Hui Wen Lan'), middle: n('Hong Fang Xia Yan Ling Juan Ping Qing'), older: n('Guiying Xiulan Yuying Fengying Shufen Lihua Meihua Cuifen')},
    m: {young: n('Wei Jun Hao Kai Yifan Zihan Rui Tao'), middle: n('Jian Bin Gang Ming Lei Qiang Feng Bo'), older: n('Guoqiang Jianguo Zhiwei Dewei Yongming Wenhua Shuping Baoshan')},
  },
  vietnamese: {
    f: {young: n('Linh Trang Anh Ngoc Thao Vy Mai Huong'), middle: n('Lan Thuy Hoa Hanh Hien Nga Phuong Dung'), older: n('Bich Hong Tuyet Kim Loan Cuc Sen Yen')},
    m: {young: n('Minh Khoa Huy Tuan Nam Bao Duc Long'), middle: n('Hung Thanh Dung Quang Son Trung Hai Phong'), older: n('Binh Cuong Hoang Lam Tam Vinh Phuc Thien')},
  },
  korean: {
    f: {young: n('Jiwoo Seoyeon Minji Yuna Haeun Soyeon Jiyoung Eunbi'), middle: n('Mijin Sunhee Eunjung Hyejin Jiyeon Yoonhee Sooyoung Kyungmi'), older: n('Soonja Youngja Okja Myungsook Jungsook Kyungsook Sunja Malsoon')},
    m: {young: n('Minjun Jihoon Hyunwoo Seojun Junho Dohyun Jaewon Taeyang'), middle: n('Sungho Youngsoo Jinho Dongwook Kyungho Sangwoo Jaesung Hyunsoo'), older: n('Youngho Byungchul Chulsoo Kwangsoo Sangchul Duhwan Jongsu Myungho')},
  },
  filipino: {
    f: {young: n('Angel Princess Bea Kyla Trisha Nicole Jasmine Andrea'), middle: n('Maricel Rowena Marites Jocelyn Liza Grace Cherry Lorna'), older: n('Remedios Corazon Erlinda Purita Lourdes Milagros Teresita Rosario')},
    m: {young: n('Paolo Miguel Carlo Jericho Kenneth Joshua Mark Bryan'), middle: n('Romeo Arnel Rodel Jun Noel Rey Ariel Jomar'), older: n('Eduardo Ernesto Teodoro Danilo Rolando Florencio Emilio Cesar')},
  },
  indian: {
    f: {young: n('Priya Ananya Diya Isha Kavya Riya Neha Pooja'), middle: n('Sunita Anjali Rekha Meena Kavita Deepa Sangeeta Lakshmi'), older: n('Kamala Savitri Shanti Usha Lalita Parvati Sushila Pushpa')},
    m: {young: n('Arjun Rohan Aditya Vikram Kunal Rahul Dev Nikhil'), middle: n('Raj Sanjay Anil Vijay Suresh Ramesh Ajay Manoj'), older: n('Prakash Mohan Krishna Gopal Hari Narayan Shankar Ravi')},
  },
  arabic: {
    f: {young: n('Layla Noor Yasmin Mariam Salma Amira Lina Dana'), middle: n('Rania Huda Samira Nadia Hanan Mona Leila Reem'), older: n('Fatima Khadija Aisha Zainab Amina Naima Samia Souad')},
    m: {young: n('Omar Yusuf Adam Karim Zaid Rami Hamza Tariq'), middle: n('Ahmed Khalid Samir Walid Nabil Hassan Majid Fadi'), older: n('Mahmoud Ibrahim Abdullah Mustafa Said Jamal Hussein Farouk')},
  },
  persian: {
    f: {young: n('Shirin Yasaman Nazanin Parisa Ava Sara Niloufar Tara'), middle: n('Mina Laleh Azadeh Shabnam Mahnaz Golnaz Roya Neda'), older: n('Parvin Mahin Pouran Simin Fereshteh Zahra Shahla Touran')},
    m: {young: n('Arash Kian Dariush Navid Babak Ramin Kamran Cyrus'), middle: n('Reza Behrouz Farhad Mehdi Saeed Amir Hamid Majid'), older: n('Hossein Bahram Jamshid Parviz Manouchehr Houshang Gholam Ali')},
  },
  nigerian: {
    f: {young: n('Chioma Adaeze Temi Funmi Amaka Zainab Ifeoma Tolu'), middle: n('Ngozi Folake Bisi Nkechi Yetunde Abimbola Uche Halima'), older: n('Comfort Patience Grace Adunni Ebele Titilayo Nneka Mojisola')},
    m: {young: n('Tunde Emeka Chidi Femi Seun Obinna Ayo Kelechi'), middle: n('Chinedu Segun Kunle Ikenna Babatunde Olumide Nnamdi Gbenga'), older: n('Adewale Chukwuma Ibrahim Festus Godwin Sunday Olu Okon')},
  },
  japanese: {
    f: {young: n('Yui Hina Aoi Sakura Mio Rin Haruka Saki'), middle: n('Yuko Naomi Akiko Megumi Tomoko Keiko Mayumi Kumiko'), older: n('Fumiko Michiko Setsuko Kazuko Hiroko Sachiko Yoshiko Chiyo')},
    m: {young: n('Haruto Ren Sota Yuto Kaito Riku Daiki Shota'), middle: n('Takeshi Hiroshi Kenji Satoshi Makoto Daisuke Kazuya Tetsuya'), older: n('Masao Shigeru Isamu Tadashi Noboru Yoshio Akira Minoru')},
  },
};
const INITIALS = 'ABCDEFGHJKLMNPRSTVW';

// Gear, the clue to style, and how much each leans toward each style.
export const GEARS = ['', 'hoodie', 'headphones', 'sunglasses', 'cap', 'beanie', 'tourist', 'jacket'];
const GEAR_LEAN = {
  '': {rock: 1, station: 1, maniac: 1, grinder: 1},
  hoodie: {grinder: 2.2},
  headphones: {grinder: 2.4},
  sunglasses: {grinder: 2.2},
  beanie: {grinder: 1.4, maniac: 1.3},
  cap: {station: 1.7, maniac: 1.7},
  tourist: {station: 1.8, maniac: 1.6},
  jacket: {rock: 2.2},
};
// How common each gear is before the leans: about half of people wear none.
const GEAR_SHARE = {'': 6, hoodie: 1, headphones: 1, sunglasses: 0.8, cap: 1, beanie: 0.7, tourist: 0.9, jacket: 1};
const AGE_LEAN = {older: {rock: 2.4, maniac: 0.6}, middle: {}, young: {maniac: 1.3}};

const pick = (weights, r) => {
  const entries = Object.entries(weights);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let x = r * total;
  for (const [k, w] of entries) if ((x -= w) < 0) return k;
  return entries.at(-1)[0];
};
const one = (list, r) => list[Math.floor(r * list.length)];

// Hairstyles by gender and age band.
const HAIR = {
  f: {
    young: ['long', 'ponytail', 'bun', 'shoulder', 'pastshoulder', 'wavy', 'curlylong', 'bob', 'braid', 'curly'],
    middle: ['bob', 'shoulder', 'wavyshort', 'bun', 'long', 'ponytail', 'wavy', 'curly'],
    older: ['bob', 'wavyshort', 'short', 'bun', 'shoulder'],
  },
  m: {
    young: ['short', 'buzz', 'messy', 'spiky', 'quiff', 'curly', 'sidepart', 'slick', 'wavyshort', 'afro'],
    middle: ['short', 'sidepart', 'receding', 'buzz', 'slick', 'bald', 'wavyshort', 'curly'],
    older: ['receding', 'bald', 'sidepart', 'short', 'none'],
  },
};
const BEARDS = {
  young: ['none', 'none', 'none', 'stubble', 'goatee', 'trimmed'],
  middle: ['none', 'none', 'stubble', 'short', 'mustache', 'full', 'goatee'],
  older: ['none', 'none', 'short', 'mustache', 'full', 'grizzled'],
};
const GREYS = ['#bdbab4', '#d6d3ce', '#cfccc6', '#a9a49d'];
const DYED = ['#e8d8a8', '#6a3f8a', '#c94b8a', '#2f6fb3'];
const TOPS = ['tee', 'crewtee', 'sweater', 'shirt', 'polo', 'jacket', 'trackjacket', 'campshirt'];
const COLORS = ['#3d5a80', '#c0392b', '#2e8b57', '#6a4c93', '#d9a520', '#2b2f36', '#127a7a', '#8a6d4a', '#9b4d6a', '#e8eef6', '#5b6b4a', '#1d4e89', '#e07a2f', '#7a7f87'];
const LIGHT = ['#eef2f6', '#f2eee4', '#efe7d6', '#e8eef6'];
const BGS = ['#dde6ea', '#cfe0ec', '#f3e3cf', '#e6dccb', '#f6e3c4', '#f2d6cf', '#ecdde6', '#d9e9e2', '#d6d9e2', '#e3dcf0', '#dcefdc', '#d6e4f2', '#efe6cc', '#e8dfcb'];

/**
 * A person's look, from their style `family` and `seed`: {base, pool,
 * gender, age, gear, o} with `o` the drawing options. A base and a gear that
 * lean to the style, then the rest at random.
 */
/** The base a person with `family` and `seed` is drawn from. */
const baseWeights = new Map();
export const baseFor = (family, seed) => {
  if (!baseWeights.has(family)) baseWeights.set(family, Object.fromEntries(BASES.map(b => [b.id, AGE_LEAN[b.age]?.[family] ?? 1])));
  return BASES[+pick(baseWeights.get(family), roll(seed, 'face', 'base'))];
};

/**
 * A base's background, for who you meet where (quest-people.js
 * REGION_MIX): 'white', 'hispanic', 'black', 'eastasian', 'southasian' or
 * 'mideast'. Black players are African-American (the 'black' pool) or
 * Nigerian; Filipinos count with East and Southeast Asians.
 */
export function backgroundOf(base) {
  if (base.pool === 'black' || base.pool === 'nigerian') return 'black';
  if (['english', 'irish', 'italian', 'polish', 'greek'].includes(base.pool)) return 'white';
  if (base.pool === 'hispanic') return 'hispanic';
  if (base.pool === 'indian') return 'southasian';
  if (['arabic', 'persian'].includes(base.pool)) return 'mideast';
  return 'eastasian';
}

export function lookFor(family, seed) {
  const r = key => roll(seed, 'face', key);
  const base = baseFor(family, seed);
  const gears = GEARS.filter(g => !(base.wear && ['headphones', 'cap', 'beanie'].includes(g)) && !(base.wear && g === 'tourist'));
  const gear = pick(Object.fromEntries(gears.map(g => [g, GEAR_SHARE[g] * (GEAR_LEAN[g][family] ?? 1)])), r('gear'));
  const {gender, age} = base;
  const o = {skin: base.skin, face: base.face, bg: one(BGS, r('bg'))};
  // Hair: style and colour.
  o.hair = base.wear ? 'none' : one(HAIR[gender][age], r('hair'));
  const grey = (age === 'older' && r('grey') < 0.65) || (age === 'middle' && r('grey') < 0.12);
  o.hairC = grey ? one(GREYS, r('greyC')) : age === 'young' && r('dye') < 0.1 ? one(DYED, r('dyeC')) : base.hairC;
  if (age === 'middle' && !grey && r('graying') < 0.25) (o.x ||= []).push('graying');
  if (gender === 'm') {
    o.beard = one(BEARDS[age], r('beard'));
    o.beardC = grey ? o.hairC : base.hairC;
  }
  // Face details.
  o.mouth = one(['smile', 'smile', 'flat', 'smirk', 'grin'], r('mouth'));
  o.eyes = one(['normal', 'normal', 'normal', 'happy', 'narrow', 'sleepy'], r('eyes'));
  if (gender === 'f') {
    (o.x ||= []).push('lashes');
    if (r('earrings') < 0.35) o.x.push(r('earC') < 0.5 ? 'earrings' : 'hoops');
  }
  // (Seat avatars keep only the extras that read at seat size: lashes,
  // earrings, wrinkles, greying.)
  if (age === 'older') (o.x ||= []).push('wrinkles');
  if (r('glasses') < 0.16) o.glasses = one(age === 'older' ? ['reading', 'wire', 'round'] : ['round', 'square', 'horn', 'wire'], r('glassType'));
  // Clothes.
  o.top = one(gender === 'f' ? [...TOPS, 'blouse', 'blouse'] : TOPS, r('top'));
  if (age === 'older' && r('cardigan') < 0.35) o.top = 'cardigan';
  o.topC = one(COLORS, r('topC'));
  o.shirtC = one(LIGHT, r('shirtC'));
  if (base.wear) { o.hat = base.wear; o.hatC = one(COLORS, r('wearC')); }
  // Gear over the rest.
  if (gear === 'hoodie') o.top = 'hoodie';
  else if (gear === 'headphones') { o.hat = 'headphones'; o.hatC = one(['#1d1d1f', '#e9e9e9', '#c0392b'], r('hatC')); }
  else if (gear === 'sunglasses') o.glasses = one(['shades', 'aviator', 'wrap'], r('shades'));
  else if (gear === 'cap') { o.hat = r('capWay') < 0.5 ? 'cap' : 'backcap'; o.hatC = one(COLORS, r('hatC')); }
  else if (gear === 'beanie') { o.hat = 'beanie'; o.hatC = one(COLORS, r('hatC')); }
  else if (gear === 'tourist') {
    o.top = 'hawaiian';
    if (r('sunhat') < 0.3) { o.hat = 'sunhat'; o.hatC = one(['#f2eee4', '#e8d8a8', '#2f6fb3'], r('hatC')); }
  } else if (gear === 'jacket') { o.top = r('check') < 0.3 ? 'checkblazer' : 'blazer'; o.topC = one(['#22304a', '#2b2f36', '#5b4636', '#3a4a5c'], r('topC')); }
  return {base: base.id, pool: base.pool, gender, age, gear, o};
}

/** A first name and last initial from a look's pool, gender and age: "Kenji R.". */
export function nameFor(look, seed) {
  const list = NAMES[look.pool][look.gender][look.age];
  return `${one(list, roll(seed, 'first'))} ${INITIALS[Math.floor(roll(seed, 'initial') * INITIALS.length)]}.`;
}

const drawn = new Map();
/** A look's seat avatar as an image URL (an inline SVG), drawn once. */
export function faceUrl(look, key) {
  if (!drawn.has(key)) {
    if (drawn.size > 400) drawn.clear();
    drawn.set(key, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(seatAvatar(look.o))}`);
  }
  return drawn.get(key);
}
