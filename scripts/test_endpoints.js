const http = require('http');

const OLLAMA_PORT = 11435;
const PANEL_PORT = 6741;

async function request(options, body) {
  options.hostname = options.hostname || '127.0.0.1';
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function operatorReply(id, content) {
  return request({
    hostname: '127.0.0.1',
    port: PANEL_PORT,
    path: '/operator-reply',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, { id, content });
}

async function getPending() {
    const res = await request({
        hostname: '127.0.0.1',
        port: OLLAMA_PORT,
        path: '/debug/pending',
        method: 'GET'
    });
    return JSON.parse(res.body);
}

async function testEndpoint(path, body, expectedFormat) {
  console.log(`\n--- Testing ${path} (stream: ${body.stream}) ---`);

  // Start the request in background-ish (actually we need to wait for it or use a promise)
  const requestPromise = request({
    hostname: '127.0.0.1',
    port: OLLAMA_PORT,
    path: path,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, body);

  // Wait a bit for it to be registered
  await new Promise(r => setTimeout(r, 500));

  const pendingData = await getPending();
  if (pendingData.count === 0) {
      console.error('FAIL: No pending request found');
      return;
  }

  const requestId = pendingData.data[0].id;
  console.log(`Detected pending request ID: ${requestId}`);

  // Reply as operator
  const replyValue = "Test Result Title";
  await operatorReply(requestId, replyValue);
  console.log(`Operator replied with: ${replyValue}`);

  const response = await requestPromise;
  console.log(`Status: ${response.statusCode}`);
  console.log(`Content-Type: ${response.headers['content-type']}`);
  console.log(`Body:\n${response.body}`);

  // TODO: Add actual assertions based on expectedFormat
}

async function runTests() {
  try {
    // 1. OpenAI format, non-streaming
    await testEndpoint('/v1/chat/completions', {
      model: 'uno-reverse',
      messages: [{ role: 'user', content: 'Generate a concise title for this chat. emoji' }],
      stream: false
    }, 'openai');

    // 2. OpenAI format, streaming
    await testEndpoint('/v1/chat/completions', {
      model: 'uno-reverse',
      messages: [{ role: 'user', content: 'Generate a concise title for this chat. emoji' }],
      stream: true
    }, 'openai-stream');

    // 3. Ollama /api/chat format, non-streaming
    await testEndpoint('/api/chat', {
      model: 'uno-reverse',
      messages: [{ role: 'user', content: 'suggest 3-5 relevant follow-up questions' }],
      stream: false
    }, 'ollama-chat');

    // 4. Ollama /api/generate format, non-streaming
    await testEndpoint('/api/generate', {
      model: 'uno-reverse',
      prompt: 'generate relevant tags for this chat',
      stream: false
    }, 'ollama-generate');

  } catch (err) {
    console.error('Test failed:', err);
  }
}

runTests();
