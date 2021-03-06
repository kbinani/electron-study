'use strict';

const electron = require('electron'),
      find_free_port = require('find-free-port'),
      os = require('os'),
      fs = require('fs'),
      path = require('path'),
      strftime = require('strftime'),
      tlds = require('tlds'),
      Transcoder = require('stream-transcoder'),
      tmp = require('tmp'),
      uuidv4 = require('uuid/v4'),
      sprintf = require('sprintf'),
      which = require('which');
const HTTPProxy = require(__dirname + '/src/HTTPProxy.js'),
      Port = require(__dirname + '/src/Port.js'),
      Master = require(__dirname + '/src/Master.js'),
      Rat = require(__dirname + '/src/Rat.js'),
      Dialog = require(__dirname + '/src/Dialog.js'),
      Config = require(__dirname + '/src/Config.js'),
      i18n = require(__dirname + '/src/i18n.js');

const {app, BrowserWindow, session, ipcMain, dialog} = require('electron');

var mainWindow = null;
var shipWindow = null;
const mandatoryApiData = ['api_start2/getData', 'api_get_member/require_info', 'api_port/port'];
var mandatoryData = {};
var mainWindowClosed = false;
let config = null;
var _numFilesEncoding = 0;
var _screenRecordingToken = null;
let _proxy = null;

app.on('window-all-closed', function() {
  app.quit();
});

app.on('ready', function() {
  loadConfig();
  saveConfig();
  const scale = Rat.fromString(config.scale());
  i18n.setLocale(config.language());

  if (false) {  // オフラインで作業する時有効にする
    mandatoryApiData.forEach((it) => {
      const name = path.basename(it) + '.json';
      const filepath = path.join(__dirname, name);
      console.log(filepath);
      const str = fs.readFileSync(filepath, {encoding: 'utf8'}).toString();
      const json = JSON.parse(str);
      mandatoryData[it] = JSON.stringify(json['response'], null, 2);
    });
  }

  const options = {
    width: 1200 * scale.value(),
    height: 720 * scale.value() + 200,
    minWidth: 1200 * scale.value(),
    minHeight: 720 * scale.value() + 200,
    useContentSize: true,
  };
  const bounds = config.mainWindowBounds();
  const scrollBarSize = os.platform() == 'win32' ? 16 : 0;
  bounds.width = Math.max(options.width, bounds.width - scrollBarSize);
  bounds.height = Math.max(options.height, bounds.height - scrollBarSize);
  Object.assign(options, bounds);
  mainWindow = new BrowserWindow(options);

  find_free_port(8000, function(err, port) {
    _proxy = new HTTPProxy(port, (e) => {
      const ses = session.fromPartition('persist:nkcv');
      const proxyOptions = {
        proxyRules: 'http=localhost:' + port + ';https=direct://',
        proxyBypassRules: tlds.map((it) => '.' + it).join(','),
      };
      ses.setProxy(proxyOptions, () => {
        mainWindow.loadURL('file://' + __dirname + '/main.html');
      });
    });

    _proxy.addObserver((api, data, request_body) => {
      if (mandatoryApiData.indexOf(api) >= 0) {
        mandatoryData[api] = data;
      }
      if (mainWindow) {
        mainWindow.webContents.send(api, data, request_body);
      }
      if (shipWindow) {
        shipWindow.webContents.send(api, data, request_body);
      }
    });
  });

  mainWindow.webContents.on('dom-ready', function() {
    updateScale(config.scale());
    for (var key in mandatoryData) {
      const data = mandatoryData[key];
      if (data.length > 0) {
        mainWindow.webContents.send(key, data, '');
      }
    }

    if (config.shipWindowVisible()) {
      openShipList();
    }
    mainWindow.webContents.send('app.mute', config.mute());
    mainWindow.webContents.send('app.configDidPatched', config.data());
  });

  mainWindow.on('close', function(event) {
    if (_numFilesEncoding > 0) {
      const {dialog} = require('electron');
      dialog.showMessageBox({
        type: 'info',
        message: i18n.__('Encoding media files'),
      });
      event.preventDefault();
      return;
    }

    const bounds = mainWindow.getBounds();
    config.patch({'mainWindow.bounds': bounds}, (c) => {
      saveConfig();
    });

    const response = Dialog.confirm({
      title: i18n.__('Confirmation'),
      message: i18n.__('Exit application?'),
      yes: i18n.__('Exit'),
      no: 'Cancel'
    });
    if (!response) {
      event.preventDefault();
    }
  });

  mainWindow.on('closed', function() {
    mainWindowClosed = true;
    if (shipWindow) {
      shipWindow.close();
    }
    mainWindow = null;
  });
});

ipcMain.on('app.takeScreenshot', (event, data) => {
  const rect = data.rect;
  const width = data.width;
  const height = data.height;
  if (!mainWindow) {
    return;
  }
  mainWindow.webContents.capturePage(rect, (image) => {
    const resized = image.resize({width: width}).crop({x: 0, y: 0, width: width, height: height});
    const now = new Date();
    const filename = app.getName() + '_' + strftime('%Y%m%d-%H%M%S-%L', now) + '.png';
    const fullpath = path.join(app.getPath('pictures'), filename);
    const stream = fs.createWriteStream(fullpath);
    stream.write(resized.toPNG());
    stream.end();
  });
});

ipcMain.on('app.openShipList', function(event, data) {
  openShipList();
});

ipcMain.on('app.scale', function(event, scale_rat_string) {
  updateScale(scale_rat_string);
  config.patch({'scale': scale_rat_string});
  saveConfig();
});

ipcMain.on('app.patchConfig', function(event, data) {
  config.patch(data, (c) => {
    saveConfig();
    [mainWindow, shipWindow].forEach((it) => {
      if (!it) {
        return;
      }
      it.webContents.send('app.configDidPatched', config.data());
    });
  });
});

ipcMain.on('app.screenRecordingToken', function() {
  _screenRecordingToken = uuidv4();
  updateWindowTitle();
  mainWindow.webContents.send('app.startScreenRecording', _screenRecordingToken);
});

ipcMain.on('app.screenRecordingStarted', function() {
  _screenRecordingToken =  null;
  updateWindowTitle();
});

ipcMain.on('app.recorded', function(event, input_filepath) {
  const scaleFactor = electron.screen.getPrimaryDisplay().scaleFactor;

  const now = new Date();
  const filename_without_ext = app.getName() + '_' + strftime('%Y%m%d-%H%M%S-%L', now);

  const content_bounds = mainWindow.getContentBounds();
  const window_bounds = mainWindow.getBounds();
  const dy = content_bounds.y - window_bounds.y;

  const scale_rat_string = config.scale();
  const scale = Rat.fromString(scale_rat_string);
  const width = 1200 * scale.value();
  const height = 720 * scale.value();

  const fallback = () => {
    const result = path.join(app.getPath('pictures'), filename_without_ext + '.webm');
    fs.rename(input_filepath, result, (err) => {
      if (err) {
        console.trace(err);
      }
    });
  };

  if (!config.encodeCapturedVideo) {
    fallback();
    return;
  }

  try {
    which.sync('ffmpeg');
  } catch (e) {
    fallback();
    return;
  }

  const temporary_mp4_file = tmp.fileSync({postfix: '.mp4'}, (err) => {
    if (err) console.trace(err);
  });
  const writer = fs.createWriteStream(temporary_mp4_file.name);
  incrementNumFilesEncoding();
  const t = new Transcoder(input_filepath)
    .format('mp4')
    .custom('vf', 'crop=' + [width, height, 0, dy].map((it) => it * scaleFactor).join(':'))
    .on('finish', function() {
      decrementNumFilesEncoding();
      const result = path.join(app.getPath('pictures'), filename_without_ext + '.mp4');
      fs.rename(temporary_mp4_file.name, result, (err) => {
        if (err) console.trace(err);
      });
      fs.unlink(input_filepath, (err) => {
        if (err) console.trace(err);
      });
    })
    .on('error', function() {
      decrementNumFilesEncoding();
      fallback();
      fs.unlink(temporary_mp4_file.name, (err) => {
        if (err) console.trace(err);
      });
    })
    .stream().pipe(writer);
});

ipcMain.on('app.notification', function(event, message) {
  const {Notification} = require('electron');
  if (Notification) {
    const n = new Notification({'title': 'nkcv', 'body': message});
    n.show();
  }
});

ipcMain.on('app.shipWindowDidLoad', function(event, data) {
  if (shipWindow == null) {
    return;
  }
  for (var key in mandatoryData) {
    const data = mandatoryData[key];
    if (data.length > 0) {
      shipWindow.webContents.send(key, data);
    }
  }
  shipWindow.webContents.send('app.shipWindowSort', config.shipWindowSort());
  shipWindow.webContents.send('app.shipWindowFilter', config.shipWindowFilter());
  shipWindow.webContents.send('app.sqlPresetList', config.sqlPresetList());
  shipWindow.webContents.send('app.languageDidChanged', config.language());
  shipWindow.webContents.send('app.shipWindowColumnWidth', config.shipWindowColumnWidth);
  shipWindow.webContents.send('app.shipWindowColumnVisibility', config.shipWindowColumnVisibility);
});

ipcMain.on('app.requestLanguageChange', (event, data) => {
  const language = data;
  i18n.setLocale(language);
  if (mainWindow != null) {
    mainWindow.webContents.send('app.languageDidChanged', language);
  }
  if (shipWindow != null) {
    shipWindow.webContents.send('app.languageDidChanged', language);
  }
  config.patch({'language': language}, (c) => {
    saveConfig();
  });
});

ipcMain.on('app.mainWindowDidLoad', (event, data) => {
  mainWindow.webContents.send('app.languageDidChanged', config.language());
});

function incrementNumFilesEncoding(num) {
  _numFilesEncoding++;
  updateWindowTitle();
}

function decrementNumFilesEncoding(num) {
  _numFilesEncoding--;
  updateWindowTitle();
}

function updateWindowTitle() {
  var title = app.getName();
  if (_numFilesEncoding > 0) {
    title += ' - ' + sprintf(i18n.__('Encoding %d media file(s)'), _numFilesEncoding);
  }
  if (_screenRecordingToken) {
    title += ' - [' + _screenRecordingToken + ']';
  }
  mainWindow.setTitle(title);
}

function updateScale(scale_rat_string) {
  if (!mainWindow) {
    return;
  }
  const scale_rat = Rat.fromString(scale_rat_string);
  const scale = scale_rat.value();
  const scrollBarSize = os.platform() == 'win32' ? 16 : 0;
  const width = 1200;
  const height = 720;
  const w = width * scale + scrollBarSize;
  const h = height * scale + scrollBarSize;
  const current = mainWindow.getSize();
  mainWindow.setMinimumSize(w, h);
  var next_w = current[0];
  var next_h = current[1];
  if (next_w < w) {
    next_w = w;
  }
  if (next_h < h) {
    next_h = h;
  }
  mainWindow.setSize(next_w, next_h);
  mainWindow.webContents.executeJavaScript('updateScale("' + scale_rat_string + '")');
}

function openShipList() {
  config.patch({'shipWindowVisible': true}, (c) => {
    saveConfig();
  });

  if (shipWindow != null) {
    shipWindow.show();
    return;
  }
  const options = {
    useContentSize: true,
    width: 1026,
  };
  const bounds = config.shipWindowBounds();
  Object.assign(options, bounds);
  shipWindow = new BrowserWindow(options);
  shipWindow.loadURL('file://' + __dirname + '/ships.html');

  shipWindow.on('close', function(event) {
    const bounds = shipWindow.getBounds();
    config.patch({'shipWindow.bounds': bounds}, (c) => {
      saveConfig();
    });

    if (mainWindowClosed) {
      return;
    }
    event.preventDefault();
    shipWindow.hide();
    config.patch({'shipWindowVisible': false}, (c) => {
      saveConfig();
    });
  });

  shipWindow.webContents.on('dom-ready', () => {
    shipWindow.webContents.send('app.configDidPatched', config.data());
  });
}

function loadConfig() {
  try {
    const config_path = path.join(app.getPath('userData'), 'config.json');
    const config_string = fs.readFileSync(config_path);
    const config_json = JSON.parse(config_string);
    config = new Config(config_json);
  } catch (e) {
    console.trace(e);
    config = new Config({});
  }
}

function saveConfig() {
  try {
    const config_path = path.join(app.getPath('userData'), 'config.json');
    config.saveTo(config_path);
  } catch (e) {
    console.trace(e);
  }
}
