/* pcprobe — measure a file's resident page-cache bytes via mincore(2).
 *
 * Isolated-repro helper for cgroup file-cache attribution. Reports how many
 * bytes of a file are currently resident in the OS page cache (the same pages
 * cgroup v2 counts toward memory.current "file"). Read-only on the target file:
 * both `stat` and `evict` open with O_RDONLY only. posix_fadvise(DONTNEED)
 * drops clean cached pages and does not require a writable descriptor.
 *
 * Usage:
 *   pcprobe stat <path>    print JSON {path,total_bytes,resident_bytes,pct}
 *   pcprobe evict <path>   drop the file's cached pages (posix_fadvise DONTNEED)
 *
 * Output is always valid JSON for arbitrary paths: the path is JSON-escaped.
 * posix_fadvise returns an error code directly (it does not set errno), so its
 * failure is reported with strerror(ret), not perror.
 *
 * No production DB is opened by this tool; callers pass a temp fixture path.
 */
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

/* Emit a string as a JSON string body (without surrounding quotes), escaping
 * quotes, backslashes, and control characters so output is always valid JSON. */
static void json_escape_print(const char *s) {
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    unsigned char c = *p;
    switch (c) {
      case '"': fputs("\\\"", stdout); break;
      case '\\': fputs("\\\\", stdout); break;
      case '\b': fputs("\\b", stdout); break;
      case '\f': fputs("\\f", stdout); break;
      case '\n': fputs("\\n", stdout); break;
      case '\r': fputs("\\r", stdout); break;
      case '\t': fputs("\\t", stdout); break;
      default:
        if (c < 0x20) printf("\\u%04x", (unsigned)c);
        else fputc((int)c, stdout);
    }
  }
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: %s {stat|evict} <path>\n", argv[0]);
    return 2;
  }
  const char *mode = argv[1];
  const char *path = argv[2];
  /* Read-only tool: never open O_RDWR. DONTNEED works on a read-only fd. */
  int fd = open(path, O_RDONLY);
  if (fd < 0) {
    perror("open");
    return 1;
  }
  struct stat st;
  if (fstat(fd, &st) != 0) {
    perror("fstat");
    close(fd);
    return 1;
  }
  long total = (long)st.st_size;

  if (strcmp(mode, "evict") == 0) {
    /* posix_fadvise returns an error number directly; it does not set errno. */
    int adv = posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED);
    if (adv != 0) {
      fprintf(stderr, "posix_fadvise: %s\n", strerror(adv));
      close(fd);
      return 1;
    }
    fputs("{\"path\":\"", stdout);
    json_escape_print(path);
    printf("\",\"evicted\":true,\"total_bytes\":%ld}\n", total);
    close(fd);
    return 0;
  }

  if (strcmp(mode, "stat") != 0) {
    fprintf(stderr, "unknown mode: %s\n", mode);
    close(fd);
    return 2;
  }

  if (total == 0) {
    fputs("{\"path\":\"", stdout);
    json_escape_print(path);
    fputs("\",\"total_bytes\":0,\"resident_bytes\":0,\"pct\":0.0}\n", stdout);
    close(fd);
    return 0;
  }

  long page = sysconf(_SC_PAGESIZE);
  void *map = mmap(NULL, (size_t)total, PROT_READ, MAP_SHARED, fd, 0);
  if (map == MAP_FAILED) {
    perror("mmap");
    close(fd);
    return 1;
  }
  size_t n = ((size_t)total + (size_t)page - 1) / (size_t)page;
  unsigned char *vec = calloc(n, 1);
  if (!vec) {
    fprintf(stderr, "calloc failed\n");
    munmap(map, (size_t)total);
    close(fd);
    return 1;
  }
  if (mincore(map, (size_t)total, vec) != 0) {
    perror("mincore");
    free(vec);
    munmap(map, (size_t)total);
    close(fd);
    return 1;
  }
  long resident_pages = 0;
  for (size_t i = 0; i < n; i++) {
    if (vec[i] & 1) resident_pages++;
  }
  long resident = resident_pages * page;
  if (resident > total) resident = total;
  double pct = total ? (100.0 * (double)resident / (double)total) : 0.0;
  fputs("{\"path\":\"", stdout);
  json_escape_print(path);
  printf("\",\"total_bytes\":%ld,\"resident_bytes\":%ld,\"pct\":%.2f}\n",
         total, resident, pct);
  free(vec);
  munmap(map, (size_t)total);
  close(fd);
  return 0;
}
