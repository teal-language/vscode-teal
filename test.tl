local Point = record
	x: number
	y: number
end

local PointMetatable: METATABLE = {
	__index = Point
}

function Point.new(x: nmuber, y: number): Point
	local self = setmetatable({}, PointMetatable) as Point

	self.x = x or 0
	self.y = y or 0

	return self
end

function Point:move(dx: number, dy: number)
	self.x = self.x + dx 
	self.y = self.y + dy
end

local pt: Point = Point.new(1, 2)
pt:move(3, 4)
