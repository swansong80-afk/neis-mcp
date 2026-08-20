// NEIS MCP Server - Cloudflare Workers
// Tools: search_school, get_meal, get_schedule, get_timetable

const NEIS_BASE = 'https://open.neis.go.kr/hub';

const ALLERGY_MAP = {
  '1': '난류', '2': '우유', '3': '메밀', '4': '땅콩', '5': '대두',
  '6': '밀', '7': '고등어', '8': '게', '9': '새우', '10': '돼지고기',
  '11': '복숭아', '12': '토마토', '13': '아황산류', '14': '호두',
  '15': '닭고기', '16': '쇠고기', '17': '오징어', '18': '조개류', '19': '잣'
};

// 날짜 자연어 → YYYYMMDD 변환
function parseDate(input) {
  const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;

  if (!input || input === '오늘' || input === 'today') return fmt(kst);
  if (input === '내일' || input === 'tomorrow') {
    kst.setDate(kst.getDate() + 1); return fmt(kst);
  }
  if (input === '어제' || input === 'yesterday') {
    kst.setDate(kst.getDate() - 1); return fmt(kst);
  }
  const cleaned = input.replace(/-/g, '');
  if (/^\d{8}$/.test(cleaned)) return cleaned;
  return fmt(kst);
}

// 월 파싱 → YYYYMM
function parseMonth(input) {
  const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const pad = n => String(n).padStart(2, '0');
  if (!input || input === '이번달' || input === '이번 달') {
    return `${kst.getFullYear()}${pad(kst.getMonth()+1)}`;
  }
  const cleaned = input.replace(/-/g, '');
  if (/^\d{6}$/.test(cleaned)) return cleaned;
  if (/^\d{1,2}$/.test(cleaned)) return `${kst.getFullYear()}${pad(cleaned)}`;
  return `${kst.getFullYear()}${pad(kst.getMonth()+1)}`;
}

// 알레르기 번호 파싱
function parseAllergy(dishName) {
  const nums = new Set();
  const matches = [...dishName.matchAll(/(\d+(?:\.\d+)*)\./g)];
  for (const m of matches) {
    m[1].split('.').filter(Boolean).forEach(n => nums.add(n));
  }
  if (nums.size === 0) return '';
  return [...nums].sort((a,b)=>parseInt(a)-parseInt(b))
    .map(n => `${n}.${ALLERGY_MAP[n] || '?'}`)
    .join(', ');
}

// 메뉴명 정리
function cleanDishName(dishName) {
  return dishName
    .replace(/\d+(?:\.\d+)*\./g, '')
    .replace(/<br\/>/g, '\n')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .join('\n');
}

// NEIS API 호출
async function neisGet(endpoint, params, apiKey) {
  const url = new URL(`${NEIS_BASE}/${endpoint}`);
  url.searchParams.set('KEY', apiKey);
  url.searchParams.set('Type', 'json');
  url.searchParams.set('pIndex', '1');
  url.searchParams.set('pSize', '100');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`NEIS API HTTP 오류: ${res.status}`);
  const data = await res.json();
  const rootKey = Object.keys(data)[0];
  if (!rootKey) throw new Error('응답 없음');
  const root = data[rootKey];
  const head = root[0]?.head;
  if (head) {
    const result = head[1]?.RESULT;
    if (result && result.CODE !== 'INFO-000') {
      if (result.CODE === 'INFO-200') return []; // 데이터 없음
      throw new Error(result.MESSAGE || '알 수 없는 오류');
    }
  }
  return root[1]?.row || [];
}

// 학교 검색
async function searchSchool(schoolName, apiKey) {
  const rows = await neisGet('schoolInfo', { SCHUL_NM: schoolName }, apiKey);
  return rows.map(r => ({
    name: r.SCHUL_NM,
    type: r.SCHUL_KND_SC_NM,
    region: r.LCTN_SC_NM,
    eduOfficeCode: r.ATPT_OFCDC_SC_CODE,
    schoolCode: r.SD_SCHUL_CODE,
    address: r.ORG_RDNMA || '',
    phone: r.ORG_TELNO || '',
  }));
}

// 학교 코드 자동 취득
async function getSchool(schoolName, apiKey) {
  const results = await searchSchool(schoolName, apiKey);
  if (results.length === 0) throw new Error(`'${schoolName}' 학교를 찾을 수 없습니다.`);
  return results[0];
}

// 학교급 → 시간표 엔드포인트
function getTimetableEndpoint(schoolType) {
  if (schoolType.includes('초등')) return 'elsTimetable';
  if (schoolType.includes('중학')) return 'misTimetable';
  return 'hisTimetable';
}

// MCP 응답 형식
const mcpResult = text => ({ content: [{ type: 'text', text }] });
const mcpError = msg => ({ content: [{ type: 'text', text: `오류: ${msg}` }], isError: true });

// Tool 정의
const TOOLS = {
  search_school: {
    description: '학교 이름으로 학교를 검색합니다. 학교 기본정보(주소, 전화번호, 학교 종류 등)를 반환합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        school_name: { type: 'string', description: '검색할 학교 이름 (예: 부산중앙초등학교, 한세고)' }
      },
      required: ['school_name']
    },
    handler: async ({ school_name }, apiKey) => {
      const results = await searchSchool(school_name, apiKey);
      if (results.length === 0) return mcpResult(`'${school_name}' 검색 결과가 없습니다.`);
      const list = results.slice(0, 5).map((s, i) =>
        `${i+1}. 📚 ${s.name} (${s.type})\n   지역: ${s.region} | 주소: ${s.address}\n   전화: ${s.phone}`
      ).join('\n\n');
      return mcpResult(`🔍 '${school_name}' 검색 결과 (상위 ${Math.min(results.length, 5)}개):\n\n${list}`);
    }
  },

  get_meal: {
    description: '학교 급식 식단 정보를 조회합니다. 메뉴, 칼로리, 원산지, 알레르기 정보를 제공합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        school_name: { type: 'string', description: '학교 이름' },
        date: { type: 'string', description: '날짜 (오늘, 내일, 어제, YYYYMMDD). 기본값: 오늘' },
        meal_type: { type: 'string', description: '식사 종류: 조식, 중식, 석식. 기본값: 전체' }
      },
      required: ['school_name']
    },
    handler: async ({ school_name, date, meal_type }, apiKey) => {
      const school = await getSchool(school_name, apiKey);
      const ymd = parseDate(date);
      const rows = await neisGet('mealServiceDietInfo', {
        ATPT_OFCDC_SC_CODE: school.eduOfficeCode,
        SD_SCHUL_CODE: school.schoolCode,
        MLSV_YMD: ymd,
      }, apiKey);

      if (rows.length === 0) {
        return mcpResult(`${school.name} ${ymd.substring(0,4)}년 ${parseInt(ymd.substring(4,6))}월 ${parseInt(ymd.substring(6,8))}일 급식 정보가 없습니다.`);
      }

      const filtered = meal_type ? rows.filter(r => r.MMEAL_SC_NM.includes(meal_type)) : rows;
      if (filtered.length === 0) return mcpResult(`${school.name} ${ymd} ${meal_type} 정보가 없습니다.`);

      const dateStr = `${ymd.substring(0,4)}년 ${parseInt(ymd.substring(4,6))}월 ${parseInt(ymd.substring(6,8))}일`;
      const text = filtered.map(r => {
        const menu = cleanDishName(r.DDISH_NM);
        const allergy = parseAllergy(r.DDISH_NM);
        const origin = r.ORPLC_INFO ? r.ORPLC_INFO.replace(/<br\/>/g, ' | ') : '';
        return [
          `🍱 【${r.MMEAL_SC_NM}】 ${school.name} ${dateStr}`,
          `\n${menu}`,
          `\n\n🔥 칼로리: ${r.CAL_INFO}`,
          allergy ? `\n⚠️ 알레르기: ${allergy}` : '',
          origin ? `\n🌿 원산지: ${origin}` : '',
        ].filter(Boolean).join('');
      }).join('\n\n' + '─'.repeat(30) + '\n\n');

      return mcpResult(text);
    }
  },

  get_schedule: {
    description: '학교 학사일정을 조회합니다. 방학, 시험, 행사 등 학교 주요 일정을 확인할 수 있습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        school_name: { type: 'string', description: '학교 이름' },
        month: { type: 'string', description: '월 (이번달, YYYYMM, 숫자만 입력 시 해당 월). 기본값: 이번달' }
      },
      required: ['school_name']
    },
    handler: async ({ school_name, month }, apiKey) => {
      const school = await getSchool(school_name, apiKey);
      const ym = parseMonth(month);
      const rows = await neisGet('SchoolSchedule', {
        ATPT_OFCDC_SC_CODE: school.eduOfficeCode,
        SD_SCHUL_CODE: school.schoolCode,
        AA_YMD: ym,
      }, apiKey);

      if (rows.length === 0) {
        return mcpResult(`${school.name} ${ym.substring(0,4)}년 ${parseInt(ym.substring(4,6))}월 학사일정이 없습니다.`);
      }

      const ymStr = `${ym.substring(0,4)}년 ${parseInt(ym.substring(4,6))}월`;
      const text = rows.map(r => {
        const d = r.AA_YMD;
        const dateStr = `${d.substring(0,4)}.${d.substring(4,6)}.${d.substring(6,8)}`;
        return `📅 ${dateStr} | ${r.EVENT_NM}${r.EVENT_CNTNT && r.EVENT_CNTNT !== r.EVENT_NM ? ` (${r.EVENT_CNTNT})` : ''}`;
      }).join('\n');

      return mcpResult(`📆 ${school.name} ${ymStr} 학사일정\n\n${text}`);
    }
  },

  get_timetable: {
    description: '학교 시간표를 조회합니다. 초등학교·중학교·고등학교를 자동으로 구분합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        school_name: { type: 'string', description: '학교 이름' },
        grade: { type: 'number', description: '학년 (1~6)' },
        class_num: { type: 'number', description: '반 번호' },
        date: { type: 'string', description: '날짜 (오늘, 내일, YYYYMMDD). 기본값: 오늘' }
      },
      required: ['school_name', 'grade', 'class_num']
    },
    handler: async ({ school_name, grade, class_num, date }, apiKey) => {
      const school = await getSchool(school_name, apiKey);
      const ymd = parseDate(date);
      const endpoint = getTimetableEndpoint(school.type);
      const year = ymd.substring(0, 4);
      const month = parseInt(ymd.substring(4, 6));
      const sem = month >= 3 && month <= 8 ? '1' : '2';

      const rows = await neisGet(endpoint, {
        ATPT_OFCDC_SC_CODE: school.eduOfficeCode,
        SD_SCHUL_CODE: school.schoolCode,
        AY: year,
        SEM: sem,
        ALL_TI_YMD: ymd,
        GRADE: String(grade),
        CLASS_NM: String(class_num),
      }, apiKey);

      if (rows.length === 0) {
        const dateStr = `${ymd.substring(0,4)}년 ${parseInt(ymd.substring(4,6))}월 ${parseInt(ymd.substring(6,8))}일`;
        return mcpResult(`${school.name} ${grade}학년 ${class_num}반 ${dateStr} 시간표가 없습니다. (주말·방학·공휴일 제외)`);
      }

      const sorted = [...rows].sort((a, b) => parseInt(a.PERIO) - parseInt(b.PERIO));
      const d = ymd;
      const dateStr = `${d.substring(0,4)}년 ${parseInt(d.substring(4,6))}월 ${parseInt(d.substring(6,8))}일`;
      const text = sorted.map(r => `  ${r.PERIO}교시: ${r.ITRT_CNTNT}`).join('\n');

      return mcpResult(`📖 ${school.name} (${school.type}) ${grade}학년 ${class_num}반\n📅 ${dateStr} 시간표\n\n${text}`);
    }
  }
};

// MCP 프로토콜 처리
async function handleMCP(request, apiKey) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({
      jsonrpc: '2.0', id: null,
      error: { code: -32700, message: 'Parse error' }
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  const { method, params, id } = body;

  const respond = result => new Response(
    JSON.stringify({ jsonrpc: '2.0', id, result }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  const respondError = (code, message) => new Response(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  try {
    if (method === 'initialize') {
      return respond({
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'neis-mcp', version: '1.0.0' }
      });
    }

    if (method === 'notifications/initialized') {
      return new Response(null, { status: 204 });
    }

    if (method === 'tools/list') {
      return respond({
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema
        }))
      });
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params;
      const tool = TOOLS[name];
      if (!tool) return respondError(-32601, `Tool '${name}'을 찾을 수 없습니다.`);
      const result = await tool.handler(args || {}, apiKey);
      return respond(result);
    }

    return respondError(-32601, `지원하지 않는 메서드: ${method}`);

  } catch (e) {
    return respond(mcpError(e.message));
  }
}

// Worker 진입점
export default {
  async fetch(request, env) {
    const apiKey = env.NEIS_API_KEY;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders, status: 204 });
    }

    const addCors = res => {
      const r = new Response(res.body, res);
      Object.entries(corsHeaders).forEach(([k,v]) => r.headers.set(k, v));
      return r;
    };

    if (!apiKey) {
      return addCors(new Response(
        JSON.stringify({ error: 'NEIS_API_KEY 환경변수가 설정되지 않았습니다.' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      ));
    }

    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return addCors(new Response(JSON.stringify({
        name: 'NEIS MCP Server',
        version: '1.0.0',
        description: '한국 학교 교육정보 MCP 서버 (급식·시간표·학사일정)',
        endpoint: '/mcp',
        tools: Object.keys(TOOLS),
        status: 'ok'
      }), { headers: { 'Content-Type': 'application/json' } }));
    }

    if (url.pathname === '/mcp' && request.method === 'POST') {
      return addCors(await handleMCP(request, apiKey));
    }

    return addCors(new Response('Not Found', { status: 404 }));
  }
};
