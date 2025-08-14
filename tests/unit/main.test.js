const { handler } = require('../../src/handlers/main');

describe('Main Handler', () => {
    test('should process job IDs', async () => {
        const event = { jobIds: ['12345'] };
        const result = await handler(event);
        expect(result.statusCode).toBe(200);
    });
});
