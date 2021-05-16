const url = require('url');
const EventEmitter = require('eventemitter2').EventEmitter2;
const WebSocket = require('ws');
const rp = require('request-promise');
const https = require('https');

module.exports = class UnifiEvents extends EventEmitter {

    constructor(opts) {
        super({
            wildcard: true
        });

        this.opts = opts || {};
        this.opts.host = this.opts.host || 'unifi';
        this.opts.port = this.opts.port || 8443;
        this.opts.username = this.opts.username || 'admin';
        this.opts.password = this.opts.password || 'ubnt';
        this.opts.site = this.opts.site || 'default';
        this.opts.unifios = this.opts.unifios || false;


        this.userAgent = 'node.js ubnt-unifi';
        this.csrfToken = '';
        this.controller = url.parse('https://' + this.opts.host + ':' + this.opts.port);

        this.jar = rp.jar();

        this.rp = rp.defaults({
            rejectUnauthorized: !this.opts.insecure,
            jar: this.jar,
            headers: {
                'User-Agent': this.userAgent
            },
            json: true
        });

        this.autoReconnectInterval = 5 * 1000;

        this.connect();
    }

    connect(reconnect) {
        this.emit('ctrl.function.connect');
        this.isClosed = false;
        const that = this;
        this._getCSRFToken().then(function( response ) {
            return that._login(reconnect)
                .then(() => {
                    that.emit('ctrl.function.connect.connected');
                    return that._listen();
                });
        }).catch((error) => {
            this.emit('ctrl.nocsrftoken.' + error);
        });
    }

    close() {
        this.isClosed = true;
        if (typeof this.ws !== "undefined")
        {
            this.ws.close();
        }

    }

    _getCSRFToken() {
        this.emit('ctrl.function._getCSRFToken');
        return new Promise((resolve, reject) => {
            if (!this.opts.unifios || this.csrfToken !== '') {
                return resolve(true);
            }

            this.emit('ctrl.csrftoken');

            const options = {
                method: 'GET',
                hostname: this.opts.host,
                port: this.opts.port,
                path: '/',
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    Accept: '*/*',
                    'x-csrf-token': 'undefined'
                },
                maxRedirects: 20,
                rejectUnauthorized: false,
                timeout: 2000,
                keepAlive: true,
            };

            const req = https.request(options, res => {
                const body = [];

                res.on('data', chunk => body.push(chunk));
                res.on('end', () => {
                    // Obtain authorization header
                    res.rawHeaders.forEach((item, index) => {
                        // X-CSRF-Token
                        if (item.toLowerCase() === 'x-csrf-token') {
                            this.csrfToken = res.rawHeaders[index + 1];
                        }
                    });

                    if (this.csrfToken === '') {
                        reject(new Error('Invalid x-csrf-token header.'));
                        return;
                    }

                    // Connected
                    return resolve('We got it!');
                });
            });

            req.on('error', error => {
                return reject(error);
            });
            req.end();
        });
    }

    _login(reconnect) {
        this.emit('ctrl.function._login');
        let endpointUrl = `${this.controller.href}api/login`;
        if (this.opts.unifios) {
            // unifios using one authorisation endpoint for protect and network.
            endpointUrl = `${this.controller.href}api/auth/login`;
        }

        return this.rp.post(endpointUrl, {
            resolveWithFullResponse: true,
            body: {
                username: this.opts.username,
                password: this.opts.password
            }
        }).catch((error) => {
            if (!reconnect) {
                this._reconnect();
            }
        });
    }

    _listen() {
        const cookies = this.jar.getCookieString(this.controller.href);
        let eventsUrl = `wss://${this.controller.host}/wss/s/${this.opts.site}/events`;
        if (this.opts.unifios) {
            eventsUrl = `wss://${this.controller.host}/proxy/network/wss/s/${this.opts.site}/events`;
        }
        this.ws = new WebSocket(eventsUrl, {
            perMessageDeflate: false,
            rejectUnauthorized: !this.opts.insecure,
            headers: {
                'User-Agent': this.userAgent,
                Cookie: cookies
            }
        });

        const pingpong = setInterval(() => {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.send('ping');
            }
        }, 15000);

        this.ws.on('open', () => {
            this.isReconnecting = false;
            this.emit('ctrl.connect');
        });

        this.ws.on('message', data => {
            if (data === 'pong') {
                return;
            }
            try {
                const parsed = JSON.parse(data);
                if ('data' in parsed && Array.isArray(parsed.data)) {
                    parsed.data.forEach(entry => {
                        this._event(entry);
                    });
                }
            } catch (err) {
                this.emit('ctrl.error', err);
            }
        });

        this.ws.on('close', () => {
            this.emit('ctrl.close');
            //clearInterval(pingpong);
            //this._reconnect();
        });

        this.ws.on('error', err => {
            clearInterval(pingpong);
            this.emit('ctrl.error', err);
            this._reconnect();
        });
    }

    _reconnect() {
        if (!this.isReconnecting && !this.isClosed) {
            this.isReconnecting = true;
            setTimeout(() => {
                this.emit('ctrl.reconnect');
                this.isReconnecting = false;
                this.connect(true);
            }, this.autoReconnectInterval);
        }
    }

    _event(data) {
        if (data && data.key) {
            // TODO clarifiy what to do with events without key...
            const match = data.key.match(/EVT_([A-Z]{2})_(.*)/);
            if (match) {
                const [, group, event] = match;
                this.emit([group.toLowerCase(), event.toLowerCase()].join('.'), data);
            }
        }
    }

    _ensureLoggedIn() {
        if (this.opts.unifios) {
            return this.rp.get(`${this.controller.href}api/users/self`)
                .catch(() => {
                    return this._login();
                });
        }
        else {
            return this.rp.get(`${this.controller.href}api/self`)
                .catch(() => {
                    return this._login();
                });
        }
    }

    _url(path) {
        if (this.opts.unifios) {
            // unifios using an proxy, set extra path
            if (path.indexOf('/') === 0) {
                return `${this.controller.href}proxy/network/${path}`;
            }
            return `${this.controller.href}proxy/network/api/s/${this.opts.site}/${path}`;
        }
        else {
            if (path.indexOf('/') === 0) {
                return `${this.controller.href}${path}`;
            }
            return `${this.controller.href}api/s/${this.opts.site}/${path}`;
        }
    }

    get(path) {
        const cookies = this.jar.getCookieString(this.controller.href);
        return this._ensureLoggedIn()
            .then(() => {
                return this.rp.get(this._url(path, {
                    headers: {
                        'User-Agent': this.userAgent,
                        'x-csrf-token': this.csrfToken,
                        Cookie: cookies
                    }
                }));
            });
    }

    del(path) {
        const cookies = this.jar.getCookieString(this.controller.href);
        return this._ensureLoggedIn()
            .then(() => {
                return this.rp.del(this._url(path, {
                    headers: {
                        'User-Agent': this.userAgent,
                        'x-csrf-token': this.csrfToken,
                        Cookie: cookies
                    }
                }));
            });
    }

    post(path, body) {
        const cookies = this.jar.getCookieString(this.controller.href);
        return this._ensureLoggedIn()
            .then(() => {
                return this.rp.post(this._url(path), {
                    body: body,
                    headers: {
                        'User-Agent': this.userAgent,
                        'x-csrf-token': this.csrfToken,
                        Cookie: cookies
                    }
                });
            });
    }

    put(path, body) {
        const cookies = this.jar.getCookieString(this.controller.href);
        return this._ensureLoggedIn()
            .then(() => {
                return this.rp.put(this._url(path), {
                    body: body,
                    headers: {
                        'User-Agent': this.userAgent,
                        'x-csrf-token': this.csrfToken,
                        Cookie: cookies
                    }
                });
            });
    }
};
