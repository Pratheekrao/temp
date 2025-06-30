// config.js
const os = require('os');

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const interface of interfaces[name]) {
            if (interface.family === 'IPv4' && !interface.internal) {
                return interface.address;
            }
        }
    }
    return 'localhost';
}

module.exports = {
    COORDINATOR_IP: getLocalIP(),
    COORDINATOR_PORT: 3000,
    getNodeURL: (port) => `http://${getLocalIP()}:${port}`
};
