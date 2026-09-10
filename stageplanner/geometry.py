"""几何工具：线段相交、点在多边形内、距离计算（单位：米）。

坐标系：舞台平面，原点在观众视角的左后角，x 向右（舞台右 = 演员右侧），
y 向下（朝向观众）。
"""
import math


def dist(ax, ay, bx, by):
    return math.hypot(bx - ax, by - ay)


def polyline_length(points):
    """折线总长，points 为 (x, y) 列表。"""
    return sum(
        dist(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1])
        for i in range(len(points) - 1)
    )


def segments_intersect(p1, p2, p3, p4):
    """线段 p1-p2 与 p3-p4 是否规范相交（不含仅端点接触）。"""
    def cross(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    d1 = cross(p3, p4, p1)
    d2 = cross(p3, p4, p2)
    d3 = cross(p1, p2, p3)
    d4 = cross(p1, p2, p4)
    if ((d1 > 0 and d2 < 0) or (d1 < 0 and d2 > 0)) and \
       ((d3 > 0 and d4 < 0) or (d3 < 0 and d4 > 0)):
        return True
    return False


def segment_intersects_polygon(a, b, poly, stop_tolerance=0.001):
    """线段 a-b 是否穿过多边形（规范相交即穿过障碍；起止点落在边界顶点
    上视为合法停靠，不算穿越）。"""
    n = len(poly)
    for i in range(n):
        c = poly[i]
        d = poly[(i + 1) % n]
        if segments_intersect(a, b, c, d):
            return True
        # 重合于障碍边：排除"端点就是障碍顶点"的合法情况
        if _segments_overlap(a, b, c, d):
            endpoints = {a, b}
            poly_pts = set((round(x, 6), round(y, 6)) for x, y in poly)
            if not all((round(x, 6), round(y, 6)) in poly_pts for x, y in endpoints):
                return True
    return False


def _segments_overlap(p1, p2, p3, p4):
    def cross(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    if cross(p1, p2, p3) != 0 or cross(p1, p2, p4) != 0:
        return False
    def on(a, b, c):
        return min(a[0], b[0]) - 1e-9 <= c[0] <= max(a[0], b[0]) + 1e-9 and \
               min(a[1], b[1]) - 1e-9 <= c[1] <= max(a[1], b[1]) + 1e-9
    return on(p1, p2, p3) and on(p1, p2, p4) or \
           on(p3, p4, p1) and on(p3, p4, p2)


def point_in_polygon(x, y, poly):
    """点是否在多边形内部（含边界）。"""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and \
           (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    if _point_on_boundary(x, y, poly):
        return True
    return inside


def _point_on_boundary(x, y, poly):
    n = len(poly)
    for i in range(n):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % n]
        if dist(ax, ay, bx, by) < 1e-12:
            continue
        cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
        if abs(cross) < 1e-6 and \
           min(ax, bx) - 1e-6 <= x <= max(ax, bx) + 1e-6 and \
           min(ay, by) - 1e-6 <= y <= max(ay, by) + 1e-6:
            return True
    return False


def segment_path_length(a, b):
    return dist(a[0], a[1], b[0], b[1])
