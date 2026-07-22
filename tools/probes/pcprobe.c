/* pcprobe — measure a file's resident page-cache bytes via mincore(2).
 *
 * Isolated-repro helper for cgroup file-cache attribution. Reports how many
 * bytes of a file are currently resident in the OS page cache (the same pages
 * cgroup v2 counts toward memory.current "file"). Read-only on the target file.
 *
 * Usage:
 *   pcprobe stat <path>    print JSON {path,total_bytes,resident_bytes,pct}
 *   pcprobe evict <path>   drop the file's cached pages (posix_fadvise DONTNEED)
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

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: %s {stat|evict} <path>\n", argv[0]);
    return 2;
  }
  const char *mode = argv[1];
  const char *path = argv[2];
  int oflags = strcmp(mode, "evict") == 0 ? O_RDWR : O_RDONLY;
  int fd = open(path, oflags);
  if (fd < 0 && oflags == O_RDWR) fd = open(path, O_RDONLY);
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
    /* Flush dirty pages first; DONTNEED only drops clean pages. */
    (void)fsync(fd);
    if (posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED) != 0) {
      perror("posix_fadvise");
      close(fd);
      return 1;
    }
    printf("{\"path\":\"%s\",\"evicted\":true,\"total_bytes\":%ld}\n", path, total);
    close(fd);
    return 0;
  }

  if (strcmp(mode, "stat") != 0) {
    fprintf(stderr, "unknown mode: %s\n", mode);
    close(fd);
    return 2;
  }

  if (total == 0) {
    printf("{\"path\":\"%s\",\"total_bytes\":0,\"resident_bytes\":0,\"pct\":0.0}\n", path);
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
  printf("{\"path\":\"%s\",\"total_bytes\":%ld,\"resident_bytes\":%ld,\"pct\":%.2f}\n",
         path, total, resident, pct);
  free(vec);
  munmap(map, (size_t)total);
  close(fd);
  return 0;
}
