// Minimal FreeRTOS stand-in for the native build.
//
// WHY THIS EXISTS AT ALL
//
// icomLanClient.h carries #else branches for a non-Arduino build, but those are
// prototype scaffolding for the single-threaded smoke tests: audioLock() and
// drainAudioRx() are empty and there is no TX path. The product path -- the one
// actually flown against a radio -- is the #ifdef ARDUINO branch with a
// dedicated audio task. The native build therefore defines ARDUINO and supplies
// the handful of FreeRTOS primitives that branch needs, so both targets execute
// the same code rather than two divergent ones.
//
// Only what icomLanClient.h uses is here: task creation, the notify
// give/take pair used to wake the audio thread, and the critical-section pair.
#pragma once

#include <stdint.h>

typedef int      BaseType_t;
typedef uint32_t UBaseType_t;
typedef uint32_t TickType_t;

#define pdTRUE  1
#define pdFALSE 0
#define pdPASS  1
#define pdFAIL  0

#define portTICK_PERIOD_MS 1u
#define pdMS_TO_TICKS(ms)  ((TickType_t)(ms))
#define portMAX_DELAY      ((TickType_t)0xFFFFFFFFu)

#define tskNO_AFFINITY       0x7FFFFFFF
#define ARDUINO_RUNNING_CORE 1

struct NativeTask;
typedef NativeTask *TaskHandle_t;

typedef void (*TaskFunction_t)(void *);

// The ESP32 pins the audio task to a core and gives it a priority; on a PC the
// OS scheduler owns both decisions, so coreId and priority are accepted and
// ignored rather than removed from the shared call site.
BaseType_t xTaskCreatePinnedToCore(TaskFunction_t entry, const char *name,
                                   uint32_t stackDepth, void *parameters,
                                   UBaseType_t priority, TaskHandle_t *handle,
                                   BaseType_t coreId);

BaseType_t xTaskCreate(TaskFunction_t entry, const char *name,
                       uint32_t stackDepth, void *parameters,
                       UBaseType_t priority, TaskHandle_t *handle);

// Passing nullptr means "delete the calling task", matching FreeRTOS.
void vTaskDelete(TaskHandle_t handle);
void vTaskDelay(TickType_t ticks);

// Wakes a task blocked in ulTaskNotifyTake. Safe to call with a null handle,
// which the shared code does while the channel is closing.
void xTaskNotifyGive(TaskHandle_t handle);

// Blocks until notified or until the timeout expires. Returns the notification
// count before clearing; clearOnExit=pdTRUE resets it to zero, which is the
// only mode the shared code uses.
uint32_t ulTaskNotifyTake(BaseType_t clearOnExit, TickType_t ticksToWait);

// ---------------------------------------------------------------------------
// Critical sections
//
// portENTER_CRITICAL on the ESP32 is a spinlock that also disables interrupts.
// Here it is a plain recursive mutex: the audio thread and the sketch loop are
// ordinary threads, and the shared code only ever guards short ring-buffer
// updates with it.
// ---------------------------------------------------------------------------
struct portMUX_TYPE {
  void *handle = nullptr;
};

#define portMUX_INITIALIZER_UNLOCKED portMUX_TYPE()

void portENTER_CRITICAL(portMUX_TYPE *mux);
void portEXIT_CRITICAL(portMUX_TYPE *mux);
