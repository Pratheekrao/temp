// storage-node.js
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const config = require('./config');

const app = express();
const PORT = process.env.NODE_PORT || 3001;
const COORDINATOR_URL = `http://${config.COORDINATOR_IP}:${config.COORDINATOR_PORT}`;
const NODE_URL = config.getNodeURL(PORT);


// In-memory chunk storage (in production, use persistent storage)
let chunks = {};

app.use(express.json({ limit: '50mb' }));

// Ensure chunks directory exists
const chunksDir = path.join(__dirname, 'chunks');
fs.mkdir(chunksDir, { recursive: true }).catch(console.error);

// Register with coordinator on startup
async function registerWithCoordinator() {
    try {
        await axios.post(`${COORDINATOR_URL}/register-node`, {
            nodeUrl: NODE_URL
        });
        console.log(`Registered with coordinator at ${COORDINATOR_URL}`);
    } catch (error) {
        console.error('Failed to register with coordinator:', error.message);
        setTimeout(registerWithCoordinator, 5000); // Retry after 5 seconds
    }
}

// Store chunk endpoint
app.post('/store-chunk', async (req, res) => {
    try {
        const { chunkId, fileId, chunkIndex, data } = req.body;
        
        if (!chunkId || !fileId || chunkIndex === undefined || !data) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Store chunk in memory (in production, save to disk)
        chunks[chunkId] = {
            fileId,
            chunkIndex,
            data,
            storedAt: new Date().toISOString()
        };

        // Optionally save to disk for persistence
        const chunkPath = path.join(chunksDir, `${chunkId}.chunk`);
        await fs.writeFile(chunkPath, data, 'base64');

        console.log(`Stored chunk ${chunkId} for file ${fileId}`);
        res.json({ message: 'Chunk stored successfully' });

    } catch (error) {
        console.error('Store chunk error:', error);
        res.status(500).json({ error: 'Failed to store chunk' });
    }
});

// Retrieve chunk endpoint
app.get('/get-chunk/:chunkId', async (req, res) => {
    try {
        const { chunkId } = req.params;
        
        // Try to get from memory first
        let chunk = chunks[chunkId];
        
        // If not in memory, try to load from disk
        if (!chunk) {
            const chunkPath = path.join(chunksDir, `${chunkId}.chunk`);
            try {
                const data = await fs.readFile(chunkPath, 'utf8');
                chunk = { data };
            } catch (error) {
                return res.status(404).json({ error: 'Chunk not found' });
            }
        }

        res.json({ data: chunk.data });

    } catch (error) {
        console.error('Get chunk error:', error);
        res.status(500).json({ error: 'Failed to retrieve chunk' });
    }
});

// List stored chunks
app.get('/chunks', (req, res) => {
    const chunkList = Object.keys(chunks).map(chunkId => ({
        chunkId,
        fileId: chunks[chunkId].fileId,
        chunkIndex: chunks[chunkId].chunkIndex,
        storedAt: chunks[chunkId].storedAt
    }));
    
    res.json({ chunks: chunkList });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        chunksStored: Object.keys(chunks).length,
        nodeUrl: NODE_URL
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Storage node running on http://0.0.0.0:${PORT}`);
    registerWithCoordinator();
});

// Periodic health check with coordinator
setInterval(async () => {
    try {
        await axios.post(`${COORDINATOR_URL}/register-node`, {
            nodeUrl: NODE_URL
        });
    } catch (error) {
        console.error('Health check failed:', error.message);
    }
}, 30000); // Every 30 seconds
