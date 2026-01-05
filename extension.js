/* exported PomodoroExtension */

import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from "gi://St";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

const PomodoroIndicator = GObject.registerClass(
  class PomodoroIndicator extends PanelMenu.Button {
    _init(settings, extensionPath) {
      super._init(0.5, "Pomodoro Timer");

      this._settings = settings;
      this._extensionPath = extensionPath;
      this._stateFile = GLib.build_filenamev([
        GLib.get_user_cache_dir(),
        "pomodoro-state.json",
      ]);
      this._statsFile = GLib.build_filenamev([
        GLib.get_user_cache_dir(),
        "pomodoro-stats.json",
      ]);

      this._workTime = this._settings.get_int("work-time");
      this._shortBreak = this._settings.get_int("short-break-time");
      this._longBreak = this._settings.get_int("long-break-time");
      this._longBreakInterval = this._settings.get_int("long-break-interval");

      this._timeLeft = this._workTime;
      this._isRunning = false;
      this._isWorkTime = true;
      this._isLongBreak = false;
      this._pomodoroCount = 0;
      this._timeout = null;
      this._signalIds = [];
      
      // Track work session start time for real focus time recording
      this._workSessionStartTime = null;
      
      // Statistics view mode: 'week' or 'month'
      this._statsViewMode = 'week';
      
      // Load statistics
      this._focusStats = this._loadStats();

      // Restore state if exists
      this._restoreState();

      // Save state periodically
      this._saveStateTimeout = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        5,
        () => {
          this._saveState();
          return GLib.SOURCE_CONTINUE;
        }
      );

      // watch settings changes
      this._onSettingsChanged = this._settings.connect("changed", () =>
        this._updateSettings()
      );
    }
    
    _loadStats() {
      try {
        const file = Gio.File.new_for_path(this._statsFile);
        if (!file.query_exists(null)) {
          return {};
        }
        const [success, contents] = file.load_contents(null);
        if (!success) return {};
        return JSON.parse(new TextDecoder().decode(contents));
      } catch (e) {
        console.error(`[Pomodoro] Error loading stats: ${e.message}`);
        return {};
      }
    }
    
    _saveStats() {
      try {
        const file = Gio.File.new_for_path(this._statsFile);
        file.replace_contents(
          JSON.stringify(this._focusStats),
          null,
          false,
          Gio.FileCreateFlags.REPLACE_DESTINATION,
          null
        );
      } catch (e) {
        console.error(`[Pomodoro] Error saving stats: ${e.message}`);
      }
    }
    
    _getTodayKey() {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }
    
    _recordFocusTime(seconds) {
      const today = this._getTodayKey();
      if (!this._focusStats[today]) {
        this._focusStats[today] = 0;
      }
      this._focusStats[today] += seconds;
      this._saveStats();
      this._updateStatsUI();
    }
    
    _getTodayFocusTime() {
      const today = this._getTodayKey();
      return this._focusStats[today] || 0;
    }
    
    _getTodayFocusTimeWithCurrent() {
      let total = this._getTodayFocusTime();
      // Add current running work session time
      if (this._isWorkTime && this._workSessionStartTime && this._isRunning) {
        const currentSessionSeconds = Math.floor((Date.now() - this._workSessionStartTime) / 1000);
        total += currentSessionSeconds;
      }
      return total;
    }
    
    _getWeekData() {
      const data = [];
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const now = new Date();
      
      for (let i = 6; i >= 0; i--) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        data.push({
          label: dayNames[date.getDay()],
          value: this._focusStats[key] || 0,
          isToday: i === 0
        });
      }
      return data;
    }
    
    _getMonthData() {
      const data = [];
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth();
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      
      for (let day = 1; day <= daysInMonth; day++) {
        const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        data.push({
          label: day.toString(),
          value: this._focusStats[key] || 0,
          isToday: day === now.getDate()
        });
      }
      return data;
    }
    
    _formatFocusTime(seconds) {
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      if (hours > 0) {
        return `${hours}h ${mins}m`;
      }
      return `${mins}m`;
    }

    _saveState() {
      try {
        const state = {
          timeLeft: this._timeLeft,
          isWorkTime: this._isWorkTime,
          isLongBreak: this._isLongBreak,
          pomodoroCount: this._pomodoroCount,
          timestamp: Date.now(),
        };
        const file = Gio.File.new_for_path(this._stateFile);
        const [success] = file.replace_contents(
          JSON.stringify(state),
          null,
          false,
          Gio.FileCreateFlags.REPLACE_DESTINATION,
          null
        );
        if (success) {
          console.log("[Pomodoro] State saved");
        }
      } catch (e) {
        console.error(`[Pomodoro] Error saving state: ${e.message}`);
      }
    }

    _restoreState() {
      try {
        const file = Gio.File.new_for_path(this._stateFile);
        if (!file.query_exists(null)) {
          console.log("[Pomodoro] No saved state found");
          return;
        }

        const [success, contents] = file.load_contents(null);
        if (!success) return;

        const state = JSON.parse(new TextDecoder().decode(contents));
        const elapsed = Math.floor((Date.now() - state.timestamp) / 1000);

        // Only restore if less than 2 hours passed
        if (elapsed < 7200) {
          this._timeLeft = Math.max(0, state.timeLeft - elapsed);
          this._isWorkTime = state.isWorkTime;
          this._isLongBreak = state.isLongBreak;
          this._pomodoroCount = state.pomodoroCount;
          console.log(`[Pomodoro] State restored, adjusted by ${elapsed}s`);
        } else {
          console.log("[Pomodoro] State too old, discarding");
          file.delete(null);
        }
      } catch (e) {
        console.error(`[Pomodoro] Error restoring state: ${e.message}`);
      }
    }

    _playSound(soundFile) {
      // Check if sound is enabled
      if (!this._settings.get_boolean("sound-enabled")) {
        return;
      }

      try {
        const soundPath = GLib.build_filenamev([
          this._extensionPath,
          "sounds",
          soundFile,
        ]);
        const file = Gio.File.new_for_path(soundPath);

        if (!file.query_exists(null)) {
          console.error(`[Pomodoro] Sound file not found: ${soundPath}`);
          return;
        }

        const player = global.display.get_sound_player();
        player.play_from_file(file, "Pomodoro Timer", null);
      } catch (e) {
        console.error(`[Pomodoro] Error playing sound: ${e.message}`);
      }
    }

    _updateSettings() {
      const oldWorkTime = this._workTime;
      this._workTime = this._settings.get_int("work-time");
      this._shortBreak = this._settings.get_int("short-break-time");
      this._longBreak = this._settings.get_int("long-break-time");
      this._longBreakInterval = this._settings.get_int("long-break-interval");

      // If we're on work phase and changed the setting, update the timer
      if (this._isWorkTime && this._timeLeft === oldWorkTime) {
        this._timeLeft = this._workTime;
        this._label.text = `🍅 ${this._formatTime(this._timeLeft)}`;
      }
    }

    buildUI() {
      // centered label with emoji
      let emoji = "🍅";
      if (!this._isWorkTime) {
        emoji = this._isLongBreak ? "☕" : "🌟";
      }
      this._label = new St.Label({
        text: `${emoji} ${this._formatTime(this._timeLeft)}`,
        y_align: Clutter.ActorAlign.CENTER,
      });

      // center text inside button
      this.add_child(this._label);

      // Progress bar for long break at top (add first)
      this._progressItem = new PopupMenu.PopupMenuItem("", {
        reactive: false,
      });
      const progressBox = new St.BoxLayout({
        vertical: true,
        style_class: "progress-container",
        style: "padding: 2px 6px 0px 0px; spacing: 0px;",
      });

      const labelBox = new St.BoxLayout({
        vertical: false,
        style_class: "label-container",
      });

      const progressLabel = new St.Label({
        text: "Work Time",
        style: "font-size: 14px; color: #ddd; font-weight: bold;",
        x_expand: true,
      });

      const countLabel = new St.Label({
        text: `0/${this._longBreakInterval}`,
        style:
          "font-size: 14px; color: #888; margin-bottom: 12px; margin-left: 0px;",
      });

      labelBox.add_child(progressLabel);
      labelBox.add_child(countLabel);

      this._countLabel = countLabel;

      const progressBar = new St.DrawingArea({
        width: 200,
        height: 10,
        style_class: "progress-bar",
      });

      progressBar.connect("repaint", () => {
        const cr = progressBar.get_context();
        const [width, height] = progressBar.get_surface_size();
        const radius = height / 2;

        // Get system accent color from St theme
        let r = 0.4,
          g = 0.8,
          b = 0.3; // fallback green
        try {
          const theme = St.ThemeContext.get_for_stage(global.stage);
          const [ok, accent] = theme.lookup_color("accent_color");
          if (ok && accent) {
            r = accent.red;
            g = accent.green;
            b = accent.blue;
          }
        } catch (e) {
          // Fallback to green if unable to get system color
        }

        // Background rounded
        cr.setSourceRGBA(0.4, 0.4, 0.4, 0.6);
        cr.moveTo(radius, 0);
        cr.lineTo(width - radius, 0);
        cr.arc(width - radius, radius, radius, -Math.PI / 2, Math.PI / 2);
        cr.lineTo(radius, height);
        cr.arc(radius, radius, radius, Math.PI / 2, -Math.PI / 2);
        cr.closePath();
        cr.fill();

        // Progress fill rounded with system accent color
        let currentCount = this._pomodoroCount % this._longBreakInterval;
        // On long break, show full progress
        if (currentCount === 0 && this._pomodoroCount > 0) {
          currentCount = this._longBreakInterval;
        }
        const progress = currentCount / this._longBreakInterval;
        const fillWidth = width * progress;
        if (fillWidth > 0) {
          cr.setSourceRGBA(r, g, b, 0.9);
          cr.moveTo(radius, 0);
          const fillRadius = Math.min(radius, fillWidth / 2);
          cr.lineTo(fillWidth - fillRadius, 0);
          if (fillWidth >= width - radius) {
            cr.arc(width - radius, radius, radius, -Math.PI / 2, Math.PI / 2);
            cr.lineTo(fillRadius, height);
            cr.arc(fillRadius, radius, fillRadius, Math.PI / 2, -Math.PI / 2);
          } else {
            cr.arc(
              fillWidth - fillRadius,
              radius,
              fillRadius,
              -Math.PI / 2,
              Math.PI / 2
            );
            cr.lineTo(fillRadius, height);
            cr.arc(fillRadius, radius, fillRadius, Math.PI / 2, -Math.PI / 2);
          }
          cr.closePath();
          cr.fill();
        }
      });

      this._progressBar = progressBar;
      this._statusLabel = progressLabel;
      this._progressCountLabel = countLabel;

      progressBox.add_child(labelBox);
      progressBox.add_child(progressBar);
      this._progressItem.actor.add_child(progressBox);
      this.menu.addMenuItem(this._progressItem);

      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      // menu items
      this._startStopItem = new PopupMenu.PopupMenuItem("Start");
      this._signalIds.push({
        obj: this._startStopItem,
        id: this._startStopItem.connect("activate", () => this._toggleTimer()),
      });
      this.menu.addMenuItem(this._startStopItem);

      this._resetItem = new PopupMenu.PopupMenuItem("Reset");
      this._signalIds.push({
        obj: this._resetItem,
        id: this._resetItem.connect("activate", () => this._resetTimer()),
      });
      this.menu.addMenuItem(this._resetItem);

      this._nextStepItem = new PopupMenu.PopupMenuItem("Next Step");
      this._signalIds.push({
        obj: this._nextStepItem,
        id: this._nextStepItem.connect("activate", () => this._nextStep()),
      });
      this.menu.addMenuItem(this._nextStepItem);

      // Statistics section
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this._buildStatsUI();

      // Update UI after restoration
      this._updateUIAfterRestore();
    }
    
    _buildStatsUI() {
      // Stats container
      this._statsItem = new PopupMenu.PopupMenuItem("", {
        reactive: false,
      });
      
      const statsBox = new St.BoxLayout({
        vertical: true,
        style: "padding: 4px 6px; spacing: 8px;",
      });
      
      // Today's focus time header
      const todayBox = new St.BoxLayout({
        vertical: false,
        style: "spacing: 8px;",
      });
      
      const todayLabel = new St.Label({
        text: "Today's Focus:",
        style: "font-size: 13px; color: #ddd; font-weight: bold;",
        x_expand: true,
      });
      
      this._todayTimeLabel = new St.Label({
        text: this._formatFocusTime(this._getTodayFocusTime()),
        style: "font-size: 13px; color: #4CAF50; font-weight: bold;",
      });
      
      todayBox.add_child(todayLabel);
      todayBox.add_child(this._todayTimeLabel);
      statsBox.add_child(todayBox);
      
      // Week/Month toggle buttons
      const toggleBox = new St.BoxLayout({
        vertical: false,
        style: "spacing: 4px; margin-bottom: 4px;",
      });
      
      this._weekBtn = new St.Button({
        label: "Week",
        style_class: "button",
        style: "padding: 4px 12px; border-radius: 4px; background-color: #4CAF50; color: white; font-size: 11px;",
      });
      
      this._monthBtn = new St.Button({
        label: "Month",
        style_class: "button",
        style: "padding: 4px 12px; border-radius: 4px; background-color: #555; color: #ccc; font-size: 11px;",
      });
      
      this._weekBtn.connect("clicked", () => {
        this._statsViewMode = 'week';
        this._weekBtn.set_style("padding: 4px 12px; border-radius: 4px; background-color: #4CAF50; color: white; font-size: 11px;");
        this._monthBtn.set_style("padding: 4px 12px; border-radius: 4px; background-color: #555; color: #ccc; font-size: 11px;");
        this._updateChart();
      });
      
      this._monthBtn.connect("clicked", () => {
        this._statsViewMode = 'month';
        this._monthBtn.set_style("padding: 4px 12px; border-radius: 4px; background-color: #4CAF50; color: white; font-size: 11px;");
        this._weekBtn.set_style("padding: 4px 12px; border-radius: 4px; background-color: #555; color: #ccc; font-size: 11px;");
        this._updateChart();
      });
      
      toggleBox.add_child(this._weekBtn);
      toggleBox.add_child(this._monthBtn);
      statsBox.add_child(toggleBox);
      
      // Chart area
      this._chartArea = new St.DrawingArea({
        width: 200,
        height: 80,
        style_class: "chart-area",
      });
      
      this._chartArea.connect("repaint", () => this._drawChart());
      statsBox.add_child(this._chartArea);
      
      // Chart labels
      this._chartLabelsBox = new St.BoxLayout({
        vertical: false,
        style: "spacing: 0px;",
      });
      statsBox.add_child(this._chartLabelsBox);
      
      this._statsItem.actor.add_child(statsBox);
      this.menu.addMenuItem(this._statsItem);
      
      this._updateChart();
    }
    
    _updateChart() {
      if (this._chartArea) {
        this._chartArea.queue_repaint();
      }
      this._updateChartLabels();
    }
    
    _updateChartLabels() {
      // Clear existing labels
      this._chartLabelsBox.destroy_all_children();
      
      const data = this._statsViewMode === 'week' ? this._getWeekData() : this._getMonthData();
      const barWidth = this._statsViewMode === 'week' ? 24 : 6;
      const spacing = this._statsViewMode === 'week' ? 4 : 1;
      
      if (this._statsViewMode === 'week') {
        // Show all day labels for week view
        data.forEach((item) => {
          const label = new St.Label({
            text: item.label,
            style: `font-size: 9px; color: ${item.isToday ? '#4CAF50' : '#888'}; width: ${barWidth + spacing}px; text-align: center;`,
            x_align: Clutter.ActorAlign.CENTER,
          });
          this._chartLabelsBox.add_child(label);
        });
      } else {
        // For month view, create a label for each bar position
        // Only show text for every 5th day and today, but keep spacing consistent
        data.forEach((item, index) => {
          const showLabel = (index + 1) % 5 === 0 || index === 0 || item.isToday;
          const label = new St.Label({
            text: showLabel ? item.label : '',
            style: `font-size: 7px; color: ${item.isToday ? '#4CAF50' : '#888'}; width: ${barWidth + spacing}px; text-align: center;`,
            x_align: Clutter.ActorAlign.CENTER,
          });
          this._chartLabelsBox.add_child(label);
        });
      }
    }
    
    _drawChart() {
      const cr = this._chartArea.get_context();
      const [width, height] = this._chartArea.get_surface_size();
      
      const data = this._statsViewMode === 'week' ? this._getWeekData() : this._getMonthData();
      const maxValue = Math.max(...data.map(d => d.value), 1); // At least 1 to avoid division by zero
      
      const barWidth = this._statsViewMode === 'week' ? 24 : 6;
      const spacing = this._statsViewMode === 'week' ? 4 : 1;
      const chartHeight = height - 5;
      
      // Get accent color
      let r = 0.3, g = 0.69, b = 0.31; // fallback green #4CAF50
      try {
        const theme = St.ThemeContext.get_for_stage(global.stage);
        const [ok, accent] = theme.lookup_color("accent_color");
        if (ok && accent) {
          r = accent.red;
          g = accent.green;
          b = accent.blue;
        }
      } catch (e) {
        // Use fallback
      }
      
      // Draw bars
      let x = 2;
      data.forEach((item) => {
        const barHeight = (item.value / maxValue) * chartHeight;
        const y = chartHeight - barHeight;
        
        // Bar background
        cr.setSourceRGBA(0.3, 0.3, 0.3, 0.5);
        cr.rectangle(x, 0, barWidth, chartHeight);
        cr.fill();
        
        // Bar fill
        if (item.isToday) {
          cr.setSourceRGBA(r, g, b, 1);
        } else {
          cr.setSourceRGBA(r, g, b, 0.6);
        }
        
        if (barHeight > 0) {
          const radius = Math.min(2, barWidth / 2, barHeight / 2);
          // Draw rounded top rectangle
          cr.moveTo(x, chartHeight);
          cr.lineTo(x, y + radius);
          cr.arc(x + radius, y + radius, radius, Math.PI, -Math.PI / 2);
          cr.lineTo(x + barWidth - radius, y);
          cr.arc(x + barWidth - radius, y + radius, radius, -Math.PI / 2, 0);
          cr.lineTo(x + barWidth, chartHeight);
          cr.closePath();
          cr.fill();
        }
        
        x += barWidth + spacing;
      });
    }
    
    _updateStatsUI() {
      if (this._todayTimeLabel) {
        this._todayTimeLabel.text = this._formatFocusTime(this._getTodayFocusTimeWithCurrent());
      }
      this._updateChart();
    }

    _updateUIAfterRestore() {
      // Update status label
      if (this._isWorkTime) {
        this._statusLabel.text = "🍅 Work Time";
      } else if (this._isLongBreak) {
        this._statusLabel.text = "☕ Long Break";
      } else {
        this._statusLabel.text = "🌟 Short Break";
      }

      // Update progress count
      let currentCount = this._pomodoroCount % this._longBreakInterval;
      if (currentCount === 0 && this._pomodoroCount > 0) {
        currentCount = this._longBreakInterval;
      }
      this._progressCountLabel.text = `${currentCount}/${this._longBreakInterval}`;

      // Repaint progress bar
      if (this._progressBar) {
        this._progressBar.queue_repaint();
      }
    }

    _formatTime(seconds) {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${mins.toString().padStart(2, "0")}:${secs
        .toString()
        .padStart(2, "0")}`;
    }

    _toggleTimer() {
      if (this._isRunning) {
        this._stopTimer();
      } else {
        this._startTimer();
      }
    }

    _startTimer() {
      this._isRunning = true;
      this._startStopItem.label.text = "Pause";

      // Track when work session starts for real focus time
      if (this._isWorkTime && !this._workSessionStartTime) {
        this._workSessionStartTime = Date.now();
      }

      if (this._timeout) {
        GLib.source_remove(this._timeout);
        this._timeout = null;
      }

      this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
        if (this._timeLeft > 0) {
          this._timeLeft--;
          let emoji = "🍅";
          if (!this._isWorkTime) {
            emoji = this._isLongBreak ? "☕" : "🌟";
          }
          this._label.text = `${emoji} ${this._formatTime(this._timeLeft)}`;
          
          // Update today's focus time in real-time during work
          if (this._isWorkTime && this._todayTimeLabel) {
            this._todayTimeLabel.text = this._formatFocusTime(this._getTodayFocusTimeWithCurrent());
          }
          
          return GLib.SOURCE_CONTINUE;
        } else {
          this._onTimerComplete();
          return GLib.SOURCE_REMOVE;
        }
      });
    }

    _stopTimer() {
      this._isRunning = false;
      this._startStopItem.label.text = "Start";

      // Record real focus time when stopping during work time
      if (this._isWorkTime && this._workSessionStartTime) {
        const elapsedSeconds = Math.floor((Date.now() - this._workSessionStartTime) / 1000);
        if (elapsedSeconds > 0) {
          this._recordFocusTime(elapsedSeconds);
        }
        this._workSessionStartTime = null;
      }

      if (this._timeout) {
        GLib.source_remove(this._timeout);
        this._timeout = null;
      }
    }

    _resetTimer() {
      this._stopTimer();
      this._isWorkTime = true;
      this._pomodoroCount = 0;
      this._isLongBreak = false;
      this._timeLeft = this._workTime;
      this._label.text = `🍅 ${this._formatTime(this._timeLeft)}`;
      this._statusLabel.text = "🍅 Work Time";

      // Update progress bar and count display
      if (this._progressBar) {
        this._progressBar.queue_repaint();
      }
      this._progressCountLabel.text = `0/${this._longBreakInterval}`;
    }

    _nextStep() {
      this._stopTimer();
      this._onTimerComplete();
    }

    _onTimerComplete() {
      this._isRunning = false;
      this._timeout = null;

      if (this._isWorkTime) {
        // Record the real elapsed work session focus time
        if (this._workSessionStartTime) {
          const elapsedSeconds = Math.floor((Date.now() - this._workSessionStartTime) / 1000);
          if (elapsedSeconds > 0) {
            this._recordFocusTime(elapsedSeconds);
          }
          this._workSessionStartTime = null;
        }
        
        this._pomodoroCount++;

        // Determine break length
        if (this._pomodoroCount % this._longBreakInterval === 0) {
          this._timeLeft = this._longBreak;
          this._statusLabel.text = "☕ Long Break";
          this._label.text = `☕ ${this._formatTime(this._timeLeft)}`;
          this._isLongBreak = true;
          this._playSound("long-break.wav");
        } else {
          this._timeLeft = this._shortBreak;
          this._statusLabel.text = "🌟 Short Break";
          this._label.text = `🌟 ${this._formatTime(this._timeLeft)}`;
          this._isLongBreak = false;
          this._playSound("break.wav");
        }
        this._isWorkTime = false;
      } else {
        // If we just finished a long break, reset the pomodoro count
        if (this._isLongBreak) {
          this._pomodoroCount = 0;
          this._isLongBreak = false;
        }

        this._timeLeft = this._workTime;
        this._statusLabel.text = "🍅 Work Time";
        this._label.text = `🍅 ${this._formatTime(this._timeLeft)}`;
        this._isWorkTime = true;
        this._playSound("focus.wav");
      }

      this._startStopItem.label.text = "Start";

      // Update progress bar and count
      if (this._progressBar) {
        this._progressBar.queue_repaint();
      }

      // Update pomodoro count display
      let currentCount = this._pomodoroCount % this._longBreakInterval;
      // On long break, show full count (e.g., 2/2 instead of 0/2)
      if (currentCount === 0 && this._pomodoroCount > 0) {
        currentCount = this._longBreakInterval;
      }
      this._progressCountLabel.text = `${currentCount}/${this._longBreakInterval}`;

      // Send notification
      if (this._settings.get_boolean("show-notifications")) {
        Main.notify(
          "Pomodoro Timer",
          this._isWorkTime ? "Time to work!" : "Take a break!"
        );
      }

      // Auto-start next phase if enabled
      if (this._settings.get_boolean("auto-start-next")) {
        this._startTimer();
      }
    }

    destroy() {
      // Save state before destroying
      this._saveState();

      // Disconnect all signals
      this._signalIds.forEach((signal) => {
        if (signal.obj && signal.id) {
          signal.obj.disconnect(signal.id);
        }
      });
      this._signalIds = [];

      // Disconnect settings signal
      if (this._onSettingsChanged) {
        this._settings.disconnect(this._onSettingsChanged);
        this._onSettingsChanged = null;
      }

      // Remove save state timeout
      if (this._saveStateTimeout) {
        GLib.source_remove(this._saveStateTimeout);
        this._saveStateTimeout = null;
      }

      // Remove timeout source
      if (this._timeout) {
        GLib.source_remove(this._timeout);
        this._timeout = null;
      }

      super.destroy();
    }
  }
);

export default class PomodoroExtension extends Extension {
  enable() {
    const settings = this.getSettings();
    this._indicator = new PomodoroIndicator(settings, this.path);
    this._indicator.buildUI();
    Main.panel.addToStatusArea(this.uuid, this._indicator);
  }

  disable() {
    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }
  }
}
