'use strict'

const http = require('http')
const Message = require('./message')
const Utils = require('./utils')
const API = require('./API')
const path = require('path')

class Group {

    constructor(token, options) {
        let self = this
        self.API = new API(typeof token === 'object' ? token : [token])
        self.options = options || {}
        self.LongPollParams = false
        self.MaxMessageId = 0
        self.EventRegistry = []
        self.EventCallbackRegistry = []
        self.LastServers = {}
        self.Members = []
        self.Id = 0
        self.ErrorLoger = Function()
        self.CallbackRegistry = {}
        self.Scenarios = {}
        self.API.api('groups.getById', {fields: 'photo_50'}, (group, error) => {
            if (!group || !group.length) return
            group = group[0]
            self.Id = parseInt(group.id)
            setInterval(() => self.executeMember(self.Id), 1000)
            if (self.options.longPoll !== false) self.longPoll()
            if (self.options.webhook && self.options.webhook.url) self.startServer(self.options.webhook)
        })
    }

    errorLoger(callback) {
        this.ErrorLoger = callback
    }

    executeMember(group_id) {
        let self = this
        if (!self.Members.length) return
        let items = self.Members.slice(0, 500)
        self.Members = self.Members.slice(500)
        self.api('groups.isMember', {user_ids: items.join(','), group_id: group_id}, (data, error) => {
            for (var i = 0; i < data.length; i++) {
                let key = 'isMember' + data[i].user_id
                if (self.CallbackRegistry[key]) self.CallbackRegistry[key](data[i].member)
            }
        })
    }

    isMember(user_id, callback) {
        let self = this
        let key = 'isMember' + user_id
        if (self.Members.indexOf(user_id) == -1) self.Members.push(user_id)
        let timerId = setTimeout(() => { 
            callback(false)
            if (self.CallbackRegistry[key]) delete self.CallbackRegistry[key]
        }, 3000)
        self.CallbackRegistry[key] = (data) => {
            callback(data)
            clearTimeout(timerId)
            if (self.CallbackRegistry[key]) delete self.CallbackRegistry[key]
        }
    }

    startServer(webhook) {
        let self = this
        if (!webhook.group_id || !webhook.confirmation) {
            return self.api('execute', {code: 'var group_id = API.groups.getById()[0].id;return {group_id: group_id, secret_key: API.groups.getCallbackServerSettings({group_id: group_id}).secret_key, confirmation: API.groups.getCallbackConfirmationCode({group_id: group_id}).code};'}, (data, error) => {
                if (!(data && data.group_id)) return startServer(webhook)
                webhook.group_id = data.group_id
                webhook.secret_key = data.secret_key
                webhook.confirmation = data.confirmation
                webhook.from_api = true
                self.startServer(webhook)
            })
        }
        let server = http.createServer((request, response) => {
            var chunks = []
            request.on('data', (chunk) => {
                chunks.push(chunk)
            })
            request.on('end', () => {
                try {
                    let json = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
                    if (!(json.group_id && json.group_id == webhook.group_id && json.type)) {
                        response.writeHead(502, {'Content-Type': 'text/plain'})
                        response.end('Required parameters are not found')
                        return
                    }
                    if (json.type == 'confirmation') {
                        response.writeHead(200, {'Content-Type': 'text/plain'})
                        response.end(webhook.confirmation)
                        return
                    }
                    if (webhook.secret_key && !(json.object && json.secret && json.secret == webhook.secret_key)) {
                        response.writeHead(200, {'Content-Type': 'text/plain'})
                        response.end('Secret key is not valid')
                        return
                    }
                    if (json.type == 'message_new' || json.type == 'message_reply') self.pushMessage(json.object)
                    let stack = self.EventCallbackRegistry
                    if (stack.length > 0) {
                        var index = 0
                        let notify = () => {
                            if (index >= stack.length) return
                                stack[index](json, () => {
                                    index++
                                    notify()
                                })
                        }
                        notify()
                    }
                    response.writeHead(200, {'Content-Type': 'text/plain'})
                    response.end('ok')
                } catch(e) {
                    // console.log(e)
                    response.writeHead(200, {'Content-Type': 'text/plain'})
                    response.end('ok')
                }
            })
        })
        server.listen((webhook.port || 80), () => {
            if (!webhook.from_api) return
            setTimeout(() => self.setCallbackServer(webhook.group_id, webhook.url), 2000)
        })
    }

    setCallbackServer(group_id, server_url, callback, attempt) {
        let self = this
        callback = callback || Function()
        attempt = attempt || 0
        attempt++
        if (attempt > 10) return callback(false, false)
        self.api('groups.setCallbackServer', {group_id: group_id, server_url: server_url}, (response, error) => {
            if (response) {
                switch(response.state_code) {
                    case 1:
                        callback(true, error)
                        break
                    case 2:
                        setTimeout(function() {
                            self.setCallbackServer(group_id, server_url, callback, attempt)
                        }, 500)
                        break
                    default:
                        callback(false, error)
                        break
                }
            } else {
                self.setCallbackServer(group_id, server_url, callback, attempt)
            }
        })
    }

    photoUpload(peer_id, file, callback, attempt) {
        let self = this
        if (Object.keys(self.LastServers).length >= 500) {
            self.LastServers = {}
        }
        attempt = attempt || 0
        attempt++
        if (attempt > 6) {
            return callback(false)
        }
        let key = 'photo' + peer_id
        if (self.LastServers[key]) {
            let log = Utils.getLogStart('upload_photo')
            Utils.upload(self.LastServers[key], {photo: file}, (upload, response) => {
                log.end()
                if (!upload) {
                    delete self.LastServers[key]
                    return self.photoUpload(peer_id, file, callback, attempt)
                }
                try {
                    upload = JSON.parse(upload)
                    self.api('photos.saveMessagesPhoto', upload, (save, error) => {
                        if (save && save.length) {
                            callback(save[0])
                        } else {
                            self.photoUpload(peer_id, file, callback, attempt)
                        }
                    })
                } catch(e) {
                    delete self.LastServers[key]
                    return self.photoUpload(peer_id, file, callback, attempt)
                }
            })
        } else {
            self.api('photos.getMessagesUploadServer', {peer_id: peer_id}, (data, error) => {
                if (data && data.upload_url) {
                    self.LastServers[key] = data.upload_url
                    self.photoUpload(peer_id, file, callback, attempt)
                } else {
                    self.photoUpload(peer_id, file, callback, attempt)
                }
            })
        }
    }


    docUpload(peer_id, file, callback, type, attempt) {
        let self = this
        if (Object.keys(self.LastServers).length >= 500) {
            self.LastServers = {}
        }
        attempt = attempt || 0
        attempt++
        if (attempt > 6) {
            return callback(false, false)
        }
        let key = 'doc' + peer_id + '_' + (type || 'file')
        if (self.LastServers[key]) {
            let log = Utils.getLogStart('upload_doc')
            Utils.upload(self.LastServers[key], {file: file}, (upload, response) => {
                log.end()
                try {
                    let uploadJSON = JSON.parse(upload)
                    if (!uploadJSON.file) {
                        throw new Error(upload)
                    }
                    self.api('docs.save', uploadJSON, (save, error) => {
                        if (save && save.length) {
                            callback(save[0])
                        } else {
                            self.docUpload(peer_id, file, callback, type, attempt)
                        }
                    })
                } catch(e) {
                    if (self.LastServers[key]) {
                        delete self.LastServers[key]
                    }
                    self.docUpload(peer_id, file, callback, type, attempt)
                }
                
            })
        } else {
            let params = {
                peer_id: peer_id
            }
            if (type) {
                params.type = type
            }
            self.api('docs.getMessagesUploadServer', params, (data, error) => {
                if (data && data.upload_url) {
                    self.LastServers[key] = data.upload_url
                }
                self.docUpload(peer_id, file, callback, type, attempt)
            })
        }
    }

    coverUpload(file, callback, params) {
        let self = this
        callback = callback || Function()
        params = params || {crop_x2: 1590, crop_y2: 400}
        if (!params.group_id) params.group_id = self.Id
        if (typeof file === 'string') {
            if (file.startsWith('http:') || file.startsWith('https:')) {
                Utils.getBuffer(file, {}, (buffer, response) => {
                    if (buffer) {
                        self.coverUpload({
                            buffer: buffer, 
                            mimetype: response.headers['content-type'],
                            filename: 'file.' + response.headers['content-type'].split(/\//)[1]
                        }, callback, params)
                    } else {
                        callback(false)
                    }
                })
            } else {
                let ext = path.extname(file)
                self.coverUpload({
                    file: file, 
                    mimetype: 'image/' + ext,
                    filename: 'file.' + ext
                }, callback, params)
            }
            return
        }
        self.api('photos.getOwnerCoverPhotoUploadServer', params, (data, error) => {
            if (error) callback(false, error)
            if (data.response) data.upload_url = data.response.upload_url
            let log = Utils.getLogStart('upload_cover')
            Utils.upload(data.upload_url, {photo: file}, (upload, response) => {
                log.end()
                try {
                    upload = JSON.parse(upload)
                    if (upload.photo) {
                        self.api('photos.saveOwnerCoverPhoto', upload, (save, error) => {
                            if (save.response) save = save.response
                            callback(save, error)
                        })
                    } else {
                        callback(false, upload)
                    }
                } catch(e) {
                    callback(false, e)
                }
            })
        })
    }

    use(callback) {
        this.EventRegistry.push(callback)
    }

    onCallBackEvent(event, callback) {
        let self = this
        self.EventCallbackRegistry.push((json, next) => {
            if (typeof event === 'string' && json.type == event) {
                callback(json.object)
            } else if (event.indexOf(json.type) >= 0) {
                callback(json.object)
            } else {
                next()
            }
        })
    }

    onMessagePhoto(callback) {
        this.use((message, next) => {
            if (message.isPhotoMessage()) {
                callback(message)
            } else {
                next()
            }
        })
    }

    onMessageAudio(callback) {
        this.use((message, next) => {
            if (message.isAudioMessage()) {
                callback(message)
            } else {
                next()
            }
        })
    }

    onMessageGif(callback) {
        this.use((message, next) => {
            if (message.isGifMessage()) {
                callback(message)
            } else {
                next()
            }
        })
    }

    onMessageDoc(callback) {
        this.use((message, next) => {
            if (message.isDocMessage()) {
                callback(message)
            } else {
                next()
            }
        })
    }

    onMessageMusic(callback) {
        this.use((message, next) => {
            if (message.isMusicMessage()) {
                callback(message)
            } else {
                next()
            }
        })
    }

    onMessageSticker(callback) {
        this.use((message, next) => {
            if (message.isStickerMessage()) {
                callback(message)
            } else {
                next()
            }
        })
    }

    onMessageText(callback) {
        this.use((message, next) => {
            if (message.isTextMessage()) {
                callback(message)
            } else {
                next()
            }
        })
    }

    onMessage(callback) {   
        this.use((message, next) => {
            callback(message)
        })
    }

    onCommand(command, callback) {
        this.use((message, next) => {
            if (!message.isTextMessage()) return next()
            let body = message.body.toLowerCase()
            if (typeof command === 'string' && body.startsWith(command.toLowerCase())) {
                callback(message)
            } else {
                for (var i = 0; i < command.length; i++) {
                    if (body.startsWith(command[i].toLowerCase())) return callback(message)
                }
                next()
            }
        })
    }

    pushMessage(json) {
        let self = this
        let stack = self.EventRegistry
        if (stack.length == 0) return
        if (json.id > self.MaxMessageId) {
            self.MaxMessageId = json.id
        } else {
            return
        }
        let message = new Message(() => {
            return self
        }, json)
        var index = 0
        let notify = () => {
            if (index >= stack.length) return
            stack[index](message, () => {
                index++
                notify()
            })
        }
        notify()
    }

    longPoll() {
        let self = this
        if (!self.LongPollParams) {
            return self.api('messages.getLongPollServer', {need_pts: 1, lp_version: 2}, (data, error) => {
                if (!data) {
                    return self.longPoll();
                }
                self.LongPollParams = data
                self.longPoll()
            })
        }
        let params = {
            act: 'a_check', 
            key: self.LongPollParams.key,
            ts: self.LongPollParams.ts,
            wait: 25,
            mode: (128 + 32 + 2),
            version: 2
        }
        Utils.get('https://' + self.LongPollParams.server, params, (data, response) => {
            if (data && response) {
                try {
                    data = JSON.parse(data)
                } catch(e) {
                    self.getLongPollHistory(self.LongPollParams.ts, self.LongPollParams.pts)
                    self.LongPollParams = false
                    self.longPoll()
                    return
                }
                if (data.pts) {
                    self.LongPollParams.pts = data.pts
                }
                if (data.ts) {
                    self.LongPollParams.ts = data.ts
                } else {
                    self.getLongPollHistory(self.LongPollParams.ts, self.LongPollParams.pts)
                    self.LongPollParams = false
                }
                self.longPoll()
                if (!data.updates || !data.updates.length) {
                    return
                }
                let messages_ids = []
                for (var i = 0; i < data.updates.length; i++) {
                    let update = data.updates[i]
                    if (update[0] != 4 || (update[2] & 2) != 0) {
                        continue
                    }
                    let attachments = update.length >= 6 ? update[6] : {}
                    if (attachments.attach1_type || attachments.fwd || attachments.geo || attachments.geo) {
                        messages_ids.push(update[1])
                    } else {
                        self.pushMessage({
                            id: update[1],
                            date: update[4],
                            out: 0,
                            user_id: update[3],
                            read_state: 0,
                            title: attachments.title || ' ... ',
                            body: update[5].replace(/<br>/g, ' '),
                            emoji: attachments.emoji || 0
                        })
                    }
                }
                if (!messages_ids.length) return
                self.api('messages.getById', {message_ids: messages_ids.join(',')}, (data, error) => {
                    if (!data || !data.items) return
                    for (var i = 0; i < data.items.length; i++) {
                        self.pushMessage(data.items[i])
                    }
                })
            } else {
                self.getLongPollHistory(self.LongPollParams.ts, self.LongPollParams.pts)
                self.LongPollParams = false
                self.longPoll()
            }
        })
    }

    getLongPollHistory(ts, pts) {
        let self = this
        self.api('messages.getLongPollHistory', {ts: ts, pts: pts, max_msg_id: self.MaxMessageId}, (data, error) => {
            if (data && data.messages) {
                let items = data.messages.items
                for (var i = 0; i < items.length; i++) {
                    self.pushMessage(items[i])
                }
            } else {
                console.log('getLongPollHistory data', data)
                console.log('getLongPollHistory error', error)
            }
        })
    }

    sendMessage(params, callback) {
        let self = this
        callback = callback || Function()
        var to_id = params.peer_id || params.user_id || params.chat_id
        if (!params.random_id) {
            params.random_id = Utils.rand() + '' + to_id + '' + Utils.time()
        }
        self.api('messages.send', params, (id, error) => {
            if (parseInt(id) >= 1) {
                callback(parseInt(id), error)
            } else {
                callback(false, error)
            }
        })
    }

    api(method, params, callback) {
        let self = this
        callback = callback || Function()
        if (parseInt(params.group_id) === 0) {
            if (self.Id != 0) {
                params.group_id = self.Id
            } else {
                return setTimeout(() => self.api(method, params, callback), 500)
            }
        }
        return self.API.api(method, params, (data, error) => {
            if (data && data.response) {
                data = data.response
            }
            if (error) {
                params.method = method
                self.ErrorLoger(params, error)
            }
            callback(data, error)
        })
    }
}

module.exports = Group
