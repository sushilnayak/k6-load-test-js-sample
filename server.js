const jsonServer = require('json-server')
const server = jsonServer.create()
const router = jsonServer.router('db.json')
const middlewares = jsonServer.defaults()

// Authentication middleware
server.use((req, res, next) => {
    const authHeader = req.headers.authorization
    const validToken = 'Bearer your-secret-token-123'  // Change this to your desired token

    if (req.path === '/health') {
        return next()
    }

    if (!authHeader || authHeader !== validToken) {
        return res.status(401).json({error: 'Unauthorized'})
    }

    // Add random delay between 100-500ms to simulate network latency
    setTimeout(next, Math.random() * 400 + 100)
})

// Add custom routes for testing different scenarios
server.get('/health', (req, res) => {
    res.json({status: 'OK'})
})

server.get('/slow-endpoint', (req, res) => {
    setTimeout(() => {
        res.json({data: 'This is a slow response'})
    }, 2000)
})

server.get('/error-endpoint', (req, res) => {
    res.status(500).json({error: 'Internal Server Error'})
})

// Use default middlewares (cors, static, etc)
server.use(middlewares)

// Use router
server.use(router)

const port = 3000
server.listen(port, () => {
    console.log(`Mock server is running on http://localhost:${port}`)
    console.log(`Use Bearer Token: your-secret-token-123`)
})
