#include "freertos_compat.h"

#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>

// A task is a std::thread plus the counting notification FreeRTOS gives every
// task for free. The audio channel uses exactly one of these.
struct NativeTask {
  std::thread            thread;
  std::mutex             lock;
  std::condition_variable wake;
  uint32_t               notifications = 0;
  bool                   finished = false;
};

namespace {

// FreeRTOS lets a task delete itself by passing nullptr. To honour that the
// shim needs to know which NativeTask the calling thread belongs to.
thread_local NativeTask *currentTask = nullptr;

std::mutex &muxRegistryLock() {
  static std::mutex lock;
  return lock;
}

std::recursive_mutex *muxFor(portMUX_TYPE *mux) {
  // Lazily attach a real mutex the first time a portMUX is entered. The shared
  // code declares these as plain members initialised with
  // portMUX_INITIALIZER_UNLOCKED, so there is no constructor hook to use.
  std::lock_guard<std::mutex> guard(muxRegistryLock());
  if (!mux->handle) mux->handle = new std::recursive_mutex();
  return static_cast<std::recursive_mutex *>(mux->handle);
}

}  // namespace

BaseType_t xTaskCreatePinnedToCore(TaskFunction_t entry, const char *,
                                   uint32_t, void *parameters, UBaseType_t,
                                   TaskHandle_t *handle, BaseType_t) {
  NativeTask *task = new (std::nothrow) NativeTask();
  if (!task) {
    if (handle) *handle = nullptr;
    return pdFAIL;
  }

  task->thread = std::thread([task, entry, parameters]() {
    currentTask = task;
    entry(parameters);
    std::lock_guard<std::mutex> guard(task->lock);
    task->finished = true;
  });
  task->thread.detach();

  if (handle) *handle = task;
  return pdPASS;
}

BaseType_t xTaskCreate(TaskFunction_t entry, const char *name,
                       uint32_t stackDepth, void *parameters,
                       UBaseType_t priority, TaskHandle_t *handle) {
  return xTaskCreatePinnedToCore(entry, name, stackDepth, parameters, priority,
                                 handle, tskNO_AFFINITY);
}

void vTaskDelete(TaskHandle_t handle) {
  NativeTask *task = handle ? handle : currentTask;
  if (!task) return;
  {
    std::lock_guard<std::mutex> guard(task->lock);
    task->finished = true;
  }
  task->wake.notify_all();
  // The thread object was detached at creation, so the OS reclaims the stack.
  // NativeTask itself is intentionally leaked: the shared code keeps calling
  // xTaskNotifyGive() on a stale handle while the channel tears down, and a
  // freed handle would turn that benign race into a use-after-free.
}

void vTaskDelay(TickType_t ticks) {
  std::this_thread::sleep_for(std::chrono::milliseconds(ticks));
}

void xTaskNotifyGive(TaskHandle_t handle) {
  if (!handle) return;
  {
    std::lock_guard<std::mutex> guard(handle->lock);
    handle->notifications++;
  }
  handle->wake.notify_one();
}

uint32_t ulTaskNotifyTake(BaseType_t clearOnExit, TickType_t ticksToWait) {
  NativeTask *task = currentTask;
  if (!task) {
    vTaskDelay(ticksToWait);
    return 0;
  }

  std::unique_lock<std::mutex> guard(task->lock);
  if (task->notifications == 0 && ticksToWait > 0) {
    task->wake.wait_for(guard, std::chrono::milliseconds(ticksToWait),
                        [task]() { return task->notifications > 0 || task->finished; });
  }

  uint32_t taken = task->notifications;
  if (clearOnExit == pdTRUE) task->notifications = 0;
  else if (task->notifications > 0) task->notifications--;
  return taken;
}

void portENTER_CRITICAL(portMUX_TYPE *mux) { muxFor(mux)->lock(); }
void portEXIT_CRITICAL(portMUX_TYPE *mux) { muxFor(mux)->unlock(); }
