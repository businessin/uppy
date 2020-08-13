const { Plugin } = require('@uppy/core')
const cuid = require('cuid')
const Translator = require('@uppy/utils/lib/Translator')
const { Provider, RequestClient, Socket } = require('@uppy/companion-client')
const emitSocketProgress = require('@uppy/utils/lib/emitSocketProgress')
const getSocketHost = require('@uppy/utils/lib/getSocketHost')
const settle = require('@uppy/utils/lib/settle')
const EventTracker = require('@uppy/utils/lib/EventTracker')
const ProgressTimeout = require('@uppy/utils/lib/ProgressTimeout')
const RateLimitedQueue = require('@uppy/utils/lib/RateLimitedQueue')
const NetworkError = require('@uppy/utils/lib/NetworkError')
const isNetworkError = require('@uppy/utils/lib/isNetworkError')
const axios = require('axios')
const createError = require('axios/lib/core/createError')

function buildResponseError (error) {
  // No error message
  if (!error) {
    error = new Error('Upload error')
  } else if (typeof error === 'string') {
    // Got an error message string
    error = new Error(error)
  } else if (!(error instanceof Error)) {
    // Got something else
    error = Object.assign(new Error('Upload error'), { data: error })
  } else if (isNetworkError(error.request)) {
    error = new NetworkError(error, error.request)
  }
  return error
}

/**
 * Set `data.type` in the blob to `file.meta.type`,
 * because we might have detected a more accurate file type in Uppy
 * https://stackoverflow.com/a/50875615
 *
 * @param {object} file File object with `data`, `size` and `meta` properties
 * @returns {object} blob updated with the new `type` set from `file.meta.type`
 */
function setTypeInBlob (file) {
  const dataWithUpdatedType = file.data.slice(0, file.data.size, file.meta.type)
  return dataWithUpdatedType
}

module.exports = class AxiosUpload extends Plugin {
  static VERSION = require('../package.json').version

  constructor (uppy, opts) {
    super(uppy, opts)
    this.type = 'uploader'
    this.id = this.opts.id || 'AxiosUpload'
    this.title = 'AxiosUpload'

    this.defaultLocale = {
      strings: {
        timedOut: 'Upload stalled for %{seconds} seconds, aborting.'
      }
    }

    // Default options
    const defaultOptions = {
      formData: true,
      fieldName: 'files[]',
      method: 'post',
      metaFields: null,
      responseUrlFieldName: 'url',
      bundle: false,
      headers: {},
      timeout: 30 * 1000,
      limit: 0,
      withCredentials: false,
      responseType: '',
      /**
       * @param {AxiosResponse} response the response object
       */
      getResponseData (response) {
        return response.data
      },
      /**
       *
       * @param {AxiosResponse} error the response object
       */
      getResponseError (error) {
        return error
      },
      /**
       * Check if the response from the upload endpoint indicates that the upload was successful.
       *
       * @param {number} status the response status code
       */
      validateStatus (status, data = null, request = null) {
        return status >= 200 && status < 300
      }
    }

    this.opts = { ...defaultOptions, ...opts }

    this.i18nInit()

    this.handleUpload = this.handleUpload.bind(this)

    // Simultaneous upload limiting is shared across all uploads with this plugin.
    // __queue is for internal Uppy use only!
    if (this.opts.__queue instanceof RateLimitedQueue) {
      this.requests = this.opts.__queue
    } else {
      this.requests = new RateLimitedQueue(this.opts.limit)
    }

    if (this.opts.bundle && !this.opts.formData) {
      throw new Error('`opts.formData` must be true when `opts.bundle` is enabled.')
    }

    this.uploaderEvents = Object.create(null)
  }

  setOptions (newOpts) {
    super.setOptions(newOpts)
    this.i18nInit()
  }

  i18nInit () {
    this.translator = new Translator([this.defaultLocale, this.uppy.locale, this.opts.locale])
    this.i18n = this.translator.translate.bind(this.translator)
    this.setPluginState() // so that UI re-renders and we see the updated locale
  }

  getOptions (file) {
    const overrides = this.uppy.getState().axiosUpload
    const opts = {
      ...this.opts,
      ...(overrides || {}),
      ...(file.axiosUpload || {}),
      headers: {}
    }
    Object.assign(opts.headers, this.opts.headers)
    if (overrides) {
      Object.assign(opts.headers, overrides.headers)
    }
    if (file.axiosUpload) {
      Object.assign(opts.headers, file.axiosUpload.headers)
    }

    return opts
  }

  addMetadata (formData, meta, opts) {
    const metaFields = Array.isArray(opts.metaFields)
      ? opts.metaFields
      // Send along all fields by default.
      : Object.keys(meta)
    metaFields.forEach((item) => {
      formData.append(item, meta[item])
    })
  }

  createFormDataUpload (file, opts) {
    const formPost = new FormData()

    this.addMetadata(formPost, file.meta, opts)

    const dataWithUpdatedType = setTypeInBlob(file)

    if (file.name) {
      formPost.append(opts.fieldName, dataWithUpdatedType, file.meta.name)
    } else {
      formPost.append(opts.fieldName, dataWithUpdatedType)
    }

    return formPost
  }

  createBundledUpload (files, opts) {
    const formPost = new FormData()

    const { meta } = this.uppy.getState()
    this.addMetadata(formPost, meta, opts)

    files.forEach((file) => {
      const opts = this.getOptions(file)

      const dataWithUpdatedType = setTypeInBlob(file)

      if (file.name) {
        formPost.append(opts.fieldName, dataWithUpdatedType, file.name)
      } else {
        formPost.append(opts.fieldName, dataWithUpdatedType)
      }
    })

    return formPost
  }

  createBareUpload (file, opts) {
    return file.data
  }

  upload (file, current, total) {
    const opts = this.getOptions(file)

    this.uppy.log(`uploading ${current} of ${total}`)
    return new Promise((resolve, reject) => {
      this.uppy.emit('upload-started', file)

      const data = opts.formData
        ? this.createFormDataUpload(file, opts)
        : this.createBareUpload(file, opts)

      this.uploaderEvents[file.id] = new EventTracker(this.uppy)

      var timer

      const id = cuid()

      const onLoadStart = (ev) => {
        this.uppy.log(`[${this.title}] ${id} started`)
      }

      const onProgress = (ev) => {
        this.uppy.log(`[${this.title}] ${id} progress: ${ev.loaded} / ${ev.total}`)
        // Begin checking for timeouts when progress starts, instead of loading,
        // to avoid timing out requests on browser concurrency queue
        timer.progress()

        if (ev.lengthComputable) {
          this.uppy.emit('upload-progress', file, {
            uploader: this,
            bytesUploaded: ev.loaded,
            bytesTotal: ev.total
          })
        }
      }

      const onLoad = (response) => {
        this.uppy.log(`[${this.title}] ${id} finished`)
        timer.done()
        queuedRequest.done()
        if (this.uploaderEvents[file.id]) {
          this.uploaderEvents[file.id].remove()
          this.uploaderEvents[file.id] = null
        }

        if (opts.validateStatus(response.status, response.data, response)) {
          const body = opts.getResponseData(response)
          const uploadURL = body[opts.responseUrlFieldName]

          const uploadResp = {
            status: response.status,
            body,
            uploadURL
          }

          this.uppy.emit('upload-success', file, uploadResp)

          if (uploadURL) {
            this.uppy.log(`Download ${file.name} from ${uploadURL}`)
          }

          return resolve(file)
        } else {
          const body = opts.getResponseData(response)
          const error = buildResponseError(opts.getResponseError(createError(
            'validation failed',
            response.config,
            'ECUSTOMVAL',
            response.request,
            response
          )))

          const errResponse = {
            status: response.status,
            body
          }

          this.uppy.emit('upload-error', file, error, errResponse)
          return reject(error)
        }
      }

      const onError = (err) => {
        this.uppy.log(`[${this.title}] ${id} errored`)
        timer.done()
        queuedRequest.done()

        if (this.uploaderEvents[file.id]) {
          this.uploaderEvents[file.id].remove()
          this.uploaderEvents[file.id] = null
        }

        if (err.response) {
          const body = opts.getResponseData(err.response)
          const error = buildResponseError(opts.getResponseError(err))

          const response = {
            status: error.response.status,
            body
          }

          this.uppy.emit('upload-error', file, error, response)
          return reject(error)
        } else {
          const error = buildResponseError(opts.getResponseError(err))
          this.uppy.emit('upload-error', file, error)
          return reject(error)
        }
      }

      const CancelToken = axios.CancelToken

      const sendRequest = (data) => {
        let cancel

        onLoadStart()

        axios({
          method: opts.method.toUpperCase(),
          url: opts.endpoint,
          withCredentials: opts.withCredentials,
          responseType: opts.responseType,
          headers: opts.headers,
          data: data,

          onUploadProgress: (ev) => {
            onProgress(ev)
          },
          cancelToken: new CancelToken(function (c) {
            cancel = c
          })
        }).then(response => {
          onLoad(response)
        }).catch(error => {
          onError(error)
        })

        timer = new ProgressTimeout(opts.timeout, () => {
          cancel()
          queuedRequest.done()
          const error = new Error(this.i18n('timedOut', { seconds: Math.ceil(opts.timeout / 1000) }))
          this.uppy.emit('upload-error', file, error)
          reject(error)
        })

        return cancel
      }

      const queuedRequest = this.requests.run(() => {
        const cancel = sendRequest(data)
        return () => {
          timer.done()
          cancel()
        }
      })

      this.onFileRemove(file.id, () => {
        queuedRequest.abort()
        reject(new Error('File removed'))
      })

      this.onCancelAll(file.id, () => {
        queuedRequest.abort()
        reject(new Error('Upload cancelled'))
      })
    })
  }

  uploadRemote (file, current, total) {
    const opts = this.getOptions(file)
    return new Promise((resolve, reject) => {
      this.uppy.emit('upload-started', file)

      const fields = {}
      const metaFields = Array.isArray(opts.metaFields)
        ? opts.metaFields
        // Send along all fields by default.
        : Object.keys(file.meta)

      metaFields.forEach((name) => {
        fields[name] = file.meta[name]
      })

      const Client = file.remote.providerOptions.provider ? Provider : RequestClient
      const client = new Client(this.uppy, file.remote.providerOptions)
      client.post(file.remote.url, {
        ...file.remote.body,
        endpoint: opts.endpoint,
        size: file.data.size,
        fieldname: opts.fieldName,
        metadata: fields,
        httpMethod: opts.method,
        useFormData: opts.formData,
        headers: opts.headers
      }).then((res) => {
        const token = res.token
        const host = getSocketHost(file.remote.companionUrl)
        const socket = new Socket({ target: `${host}/api/${token}`, autoOpen: false })
        this.uploaderEvents[file.id] = new EventTracker(this.uppy)

        this.onFileRemove(file.id, () => {
          socket.send('pause', {})
          queuedRequest.abort()
          resolve(`upload ${file.id} was removed`)
        })

        this.onCancelAll(file.id, () => {
          socket.send('pause', {})
          queuedRequest.abort()
          resolve(`upload ${file.id} was canceled`)
        })

        this.onRetry(file.id, () => {
          socket.send('pause', {})
          socket.send('resume', {})
        })

        this.onRetryAll(file.id, () => {
          socket.send('pause', {})
          socket.send('resume', {})
        })

        socket.on('progress', (progressData) => emitSocketProgress(this, progressData, file))

        socket.on('success', (data) => {
          const body = opts.getResponseData(data.response.responseText, data.response)
          const uploadURL = body[opts.responseUrlFieldName]

          const uploadResp = {
            status: data.response.status,
            body,
            uploadURL
          }

          this.uppy.emit('upload-success', file, uploadResp)
          queuedRequest.done()
          if (this.uploaderEvents[file.id]) {
            this.uploaderEvents[file.id].remove()
            this.uploaderEvents[file.id] = null
          }
          return resolve()
        })

        socket.on('error', (errData) => {
          const resp = errData.response
          const error = resp
            ? opts.getResponseError(resp.responseText, resp)
            : Object.assign(new Error(errData.error.message), { cause: errData.error })
          this.uppy.emit('upload-error', file, error)
          queuedRequest.done()
          if (this.uploaderEvents[file.id]) {
            this.uploaderEvents[file.id].remove()
            this.uploaderEvents[file.id] = null
          }
          reject(error)
        })

        const queuedRequest = this.requests.run(() => {
          socket.open()
          if (file.isPaused) {
            socket.send('pause', {})
          }

          return () => socket.close()
        })
      }).catch((err) => {
        this.uppy.emit('upload-error', file, err)
        reject(err)
      })
    })
  }

  uploadBundle (files) {
    return new Promise((resolve, reject) => {
      const endpoint = this.opts.endpoint
      const method = this.opts.method

      const optsFromState = this.uppy.getState().xhrUpload
      const formData = this.createBundledUpload(files, {
        ...this.opts,
        ...(optsFromState || {})
      })

      const xhr = new XMLHttpRequest()

      const timer = new ProgressTimeout(this.opts.timeout, () => {
        xhr.abort()
        const error = new Error(this.i18n('timedOut', { seconds: Math.ceil(this.opts.timeout / 1000) }))
        emitError(error)
        reject(error)
      })

      const emitError = (error) => {
        files.forEach((file) => {
          this.uppy.emit('upload-error', file, error)
        })
      }

      xhr.upload.addEventListener('loadstart', (ev) => {
        this.uppy.log(`[${this.title}] started uploading bundle`)
        timer.progress()
      })

      xhr.upload.addEventListener('progress', (ev) => {
        timer.progress()

        if (!ev.lengthComputable) return

        files.forEach((file) => {
          this.uppy.emit('upload-progress', file, {
            uploader: this,
            bytesUploaded: ev.loaded / ev.total * file.size,
            bytesTotal: file.size
          })
        })
      })

      xhr.addEventListener('load', (ev) => {
        timer.done()

        if (this.opts.validateStatus(ev.target.status, xhr.responseText, xhr)) {
          const body = this.opts.getResponseData(xhr.responseText, xhr)
          const uploadResp = {
            status: ev.target.status,
            body
          }
          files.forEach((file) => {
            this.uppy.emit('upload-success', file, uploadResp)
          })
          return resolve()
        }

        const error = this.opts.getResponseError(xhr.responseText, xhr) || new Error('Upload error')
        error.request = xhr
        emitError(error)
        return reject(error)
      })

      xhr.addEventListener('error', (ev) => {
        timer.done()

        const error = this.opts.getResponseError(xhr.responseText, xhr) || new Error('Upload error')
        emitError(error)
        return reject(error)
      })

      this.uppy.on('cancel-all', () => {
        timer.done()
        xhr.abort()
      })

      xhr.open(method.toUpperCase(), endpoint, true)
      // IE10 does not allow setting `withCredentials` and `responseType`
      // before `open()` is called.
      xhr.withCredentials = this.opts.withCredentials
      if (this.opts.responseType !== '') {
        xhr.responseType = this.opts.responseType
      }

      Object.keys(this.opts.headers).forEach((header) => {
        xhr.setRequestHeader(header, this.opts.headers[header])
      })

      xhr.send(formData)

      files.forEach((file) => {
        this.uppy.emit('upload-started', file)
      })
    })
  }

  uploadFiles (files) {
    const promises = files.map((file, i) => {
      const current = parseInt(i, 10) + 1
      const total = files.length

      if (file.error) {
        return Promise.reject(new Error(file.error))
      } else if (file.isRemote) {
        return this.uploadRemote(file, current, total)
      } else {
        return this.upload(file, current, total)
      }
    })

    return settle(promises)
  }

  onFileRemove (fileID, cb) {
    this.uploaderEvents[fileID].on('file-removed', (file) => {
      if (fileID === file.id) cb(file.id)
    })
  }

  onRetry (fileID, cb) {
    this.uploaderEvents[fileID].on('upload-retry', (targetFileID) => {
      if (fileID === targetFileID) {
        cb()
      }
    })
  }

  onRetryAll (fileID, cb) {
    this.uploaderEvents[fileID].on('retry-all', (filesToRetry) => {
      if (!this.uppy.getFile(fileID)) return
      cb()
    })
  }

  onCancelAll (fileID, cb) {
    this.uploaderEvents[fileID].on('cancel-all', () => {
      if (!this.uppy.getFile(fileID)) return
      cb()
    })
  }

  handleUpload (fileIDs) {
    if (fileIDs.length === 0) {
      this.uppy.log(`[${this.title}] No files to upload!`)
      return Promise.resolve()
    }

    // no limit configured by the user, and no RateLimitedQueue passed in by a "parent" plugin (basically just AwsS3) using the top secret `__queue` option
    if (this.opts.limit === 0 && !this.opts.__queue) {
      this.uppy.log(
        `[${this.title}] When uploading multiple files at once, consider setting the \`limit\` option (to \`10\` for example), to limit the number of concurrent uploads, which helps prevent memory and network issues: https://uppy.io/docs/xhr-upload/#limit-0`,
        'warning'
      )
    }

    this.uppy.log(`[${this.title}] Uploading...`)
    const files = fileIDs.map((fileID) => this.uppy.getFile(fileID))

    if (this.opts.bundle) {
      // if bundle: true, we don’t support remote uploads
      const isSomeFileRemote = files.some(file => file.isRemote)
      if (isSomeFileRemote) {
        throw new Error('Can’t upload remote files when bundle: true option is set')
      }

      return this.uploadBundle(files)
    }

    return this.uploadFiles(files).then(() => null)
  }

  install () {
    if (this.opts.bundle) {
      const { capabilities } = this.uppy.getState()
      this.uppy.setState({
        capabilities: {
          ...capabilities,
          individualCancellation: false
        }
      })
    }

    this.uppy.addUploader(this.handleUpload)
  }

  uninstall () {
    if (this.opts.bundle) {
      const { capabilities } = this.uppy.getState()
      this.uppy.setState({
        capabilities: {
          ...capabilities,
          individualCancellation: true
        }
      })
    }

    this.uppy.removeUploader(this.handleUpload)
  }
}
