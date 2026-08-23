const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

test('LLM 文本与视觉请求都强制使用 temperature=0', async () => {
    const calls = [];
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'openai') {
            return {
                OpenAI: class FakeOpenAI {
                    constructor() {
                        this.chat = {
                            completions: {
                                create: async (...args) => {
                                    calls.push(args);
                                    return { choices: [] };
                                },
                            },
                        };
                    }
                },
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    const previousEnv = {
        LLM_API_KEY: process.env.LLM_API_KEY,
        LLM_BASE_URL: process.env.LLM_BASE_URL,
        LLM_MODEL: process.env.LLM_MODEL,
        VISION_MODEL_NAME: process.env.VISION_MODEL_NAME,
    };
    process.env.LLM_API_KEY = 'test-key';
    process.env.LLM_BASE_URL = 'https://example.invalid/v1';
    process.env.LLM_MODEL = 'test-chat';
    process.env.VISION_MODEL_NAME = 'test-vision';

    try {
        const modulePath = require.resolve('../services/llmClient');
        delete require.cache[modulePath];
        const { createChatCompletion, createVisionCompletion } = require(modulePath);
        await createChatCompletion({ messages: [], temperature: 0.9 });
        await createVisionCompletion({ messages: [], temperature: 0.9 });
    } finally {
        Module._load = originalLoad;
        Object.entries(previousEnv).forEach(([key, value]) => {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        });
    }

    assert.equal(calls.length, 2);
    assert.equal(calls[0][0].model, 'test-chat');
    assert.equal(calls[1][0].model, 'test-vision');
    assert.equal(calls[0][0].temperature, 0);
    assert.equal(calls[1][0].temperature, 0);
});
